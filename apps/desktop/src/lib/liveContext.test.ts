import { describe, expect, it } from "vitest";
import { liveFor, liveLegend, liveTip, liveTokens, liveValue, type LiveContext } from "./liveContext";
import { shortTokens } from "./contextDial";
import dialSrc from "./ContextDial.svelte?raw";
import railSrc from "./RightRail.svelte?raw";
import stateSrc from "./state.svelte.ts?raw";

const r = (o: Partial<LiveContext> = {}): LiveContext => ({ exact: 120_000, estimate: 0, rough: false, steps: 1, at: 2_000, ...o });

describe("item 590: the live context reading", () => {
  it("is shown only for the turn it came from", () => {
    expect(liveFor(r(), 1_000)).not.toBeNull();
    expect(liveFor(r({ at: 500 }), 1_000)).toBeNull();
    expect(liveFor(r(), null)).not.toBeNull();
    expect(liveFor(null, 1_000)).toBeNull();
  });
  it("adds the estimate to the exact figure", () => {
    expect(liveTokens(r({ estimate: 3_456 }))).toBe(123_456);
  });
  it("marks an estimate with ~ and an exact step without", () => {
    expect(liveValue(r(), shortTokens)).toBe("120k");
    expect(liveValue(r({ estimate: 3_456 }), shortTokens)).toBe("~123k");
  });
  it("says est. for text and rough once thinking is in it", () => {
    expect(liveLegend(r(), shortTokens)).toBe("exact");
    expect(liveLegend(r({ estimate: 3_400 }), shortTokens)).toBe("+3.4k est.");
    expect(liveLegend(r({ estimate: 3_400, rough: true }), shortTokens)).toBe("+3.4k rough");
  });
  it("explains itself in the tip", () => {
    expect(liveTip(r({ estimate: 50, rough: true }))).toMatch(/thinking counted roughly/);
    expect(liveTip(r())).toMatch(/step 1/);
  });
});

describe("item 590: the wiring", () => {
  it("ContextDial's estimate defaults to none, so every other dial draws as before", () => {
    expect(dialSrc).toMatch(/estimate = null,/);
    expect(dialSrc).toMatch(/\{#if est\}\s*<circle\s+class="arc est"/);
  });
  it("the column reads the live reading only while its chat's turn runs, and passes the estimate", () => {
    expect(railSrc).toMatch(/column (?:&& !aside )?&& app\.busy && app\.live != null\s*\? liveFor\(liveContextOf\(app\.activeSessionId\)/);
    expect(railSrc).toMatch(/estimate=\{estShare\}/);
  });
  it("the turn's context_live event is stored per chat", () => {
    expect(stateSrc).toMatch(/ev\.type === "context_live"\) \{\s*noteContextLive\(host\.chat, ev\);/);
  });
});
