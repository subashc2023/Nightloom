import { describe, expect, it } from "vitest";
import { fitSidebar, SIDEBAR_MIN } from "./state.svelte";

// Nightshift item 360, the zoom audit: what it fixed at the cause, pinned.

describe("fitSidebar", () => {
  it("keeps the saved width while the window has room", () => {
    // 1440 points at 100 % and at 125 % (1152 CSS px), the default 1150 at 125 % (920).
    expect(fitSidebar(260, 1440)).toBe(260);
    expect(fitSidebar(260, 1152)).toBe(260);
    expect(fitSidebar(260, 920)).toBe(260);
  });
  it("narrows the sidebar on a narrow window under zoom, never under its minimum", () => {
    // The narrowest window (700 points) at 100, 110 and 125 %.
    expect(fitSidebar(260, 700)).toBe(238);
    expect(fitSidebar(260, 636)).toBe(216);
    expect(fitSidebar(260, 560)).toBe(SIDEBAR_MIN);
    expect(fitSidebar(440, 300)).toBe(SIDEBAR_MIN);
  });
});

// Svelte drops the whitespace at the start of a block or an element's children, so
// `{#if x} · chat{/if}` drew "s3· chat" and `<span> · {name}</span>` "Chat· subscription".
// The separator goes in as an expression, `{" · "}`, which is kept.
describe("block-leading separators", () => {
  // Every component's source, as text (Vite's raw import; the suite has no Node types).
  const files = import.meta.glob("../**/*.svelte", { query: "?raw", import: "default", eager: true }) as Record<
    string,
    string
  >;
  it("finds the components", () => {
    expect(Object.keys(files).length).toBeGreaterThan(50);
  });
  it("no block or element starts with a bare spaced separator", () => {
    const bad: string[] = [];
    const re = /(\{#if [^}]*\}|\{:else[^}]*\}|<span[^>]*>) · /g;
    for (const [f, src] of Object.entries(files)) {
      for (const m of src.matchAll(re)) bad.push(`${f}: ${m[0]}`);
    }
    expect(bad).toEqual([]);
  });
});
