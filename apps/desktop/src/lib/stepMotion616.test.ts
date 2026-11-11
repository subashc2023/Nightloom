// Item 616: Combo (the default) and Reticle join Sweep as the Thinking
// motion. The rules are read from the component's source, as 610's are.
import { describe, expect, it } from "vitest";
import messageSrc from "./AssistantMessage.svelte?raw";
import { HELPER_WINDOW } from "./stepMotion.svelte";

const css = messageSrc.slice(messageSrc.indexOf("<style"));

describe("Combo and Reticle", () => {
  it("draw a per-kind mark in place of the ■ under Combo and Reticle only", () => {
    expect(messageSrc).toMatch(/<span class="st-sq">■<\/span>\{#if kind\}<span class="st-ico k-\{kind\}"/);
    expect(css).toMatch(/\.trace:is\(\[data-motion="combo"\], \[data-motion="reticle"\]\) \.st-sq \{\s*display: none;/);
    // Sweep's mark motions stay Sweep's.
    expect(css).toMatch(/\.trace\[data-motion="sweep"\] \.mo-run\[data-kind="think"\] \.st-running \{\s*animation: mo-heart/);
  });

  it("give Combo the tint, brackets, edge light and the drifting texture", () => {
    expect(css).toMatch(/\.trace:is\(\[data-motion="combo"\], \[data-motion="reticle"\]\) \.mo-bg,/);
    expect(css).toMatch(/\.trace\[data-motion="combo"\] \.mo-edge \{\s*display: block;/);
    expect(css).toMatch(/\.trace\[data-motion="combo"\] \.mo-tex \{\s*display: block;/);
    expect(messageSrc).toMatch(/<rect class="e-tail"[^>]*pathLength="100"/);
  });

  it("fills a running helper's bar to its context out of 300k under Combo, by scale", () => {
    expect(HELPER_WINDOW).toBe(300_000);
    expect(messageSrc).toMatch(/class="tbar-ctx" style:transform="scaleX\(\{Math\.min\(1, ctx \/ HELPER_WINDOW\)\}\)"/);
    expect(messageSrc).toMatch(/context \{fmtTokens\(ctx\)\} \/ \{fmtTokens\(HELPER_WINDOW\)\} · \{Math\.round/);
    expect(messageSrc).toMatch(/running \? helperContext\(seg\.call\) : null/);
  });

  it("animates transform, opacity and stroke-dashoffset only — never left or width", () => {
    const frames = [...css.matchAll(/@keyframes -global-mo-[\w-]+ \{([\s\S]*?)\n  \}/g)].map((m) => m[1]);
    expect(frames.length).toBeGreaterThan(10);
    for (const f of frames) {
      const props = [...f.matchAll(/^\s+([a-z-]+):/gm)].map((m) => m[1]);
      for (const p of props) expect(["transform", "opacity", "stroke-dashoffset", "background-position"]).toContain(p);
    }
  });

  it("keeps every new animation under no-preference (still under Reduce motion)", () => {
    const media = css.indexOf("@media (prefers-reduced-motion: no-preference) {\n    /* The thread:");
    const end = css.indexOf("@keyframes -global-mo-run");
    expect(media).toBeGreaterThan(0);
    for (const k of ["mo-lock", "mo-edge", "mo-spin", "mo-pkt", "mo-drift", "mo-band"]) {
      const at = css.indexOf(`animation: ${k}`);
      expect(at, k).toBeGreaterThan(media);
      expect(at, k).toBeLessThan(end);
    }
  });
});
