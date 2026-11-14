import { describe, expect, it } from "vitest";
import topBar from "./TopBar.svelte?raw";
import topBarClassic from "./TopBarClassic.svelte?raw";

/**
 * Item 595 ("either both dials or both bars"): the top bar's gauge chip
 * shows every reading in one form — a small dial and its figure — each
 * with its own hover naming it. Classic's bar is untouched.
 */
const chip = (() => {
  const a = topBar.indexOf('class="ns-chip mono gauge');
  const b = topBar.indexOf("</button>", a);
  return topBar.slice(a, b);
})();

describe("595: the top bar gauge, one form", () => {
  it("draws each reading as a dial with its figure, no bar", () => {
    const readings = chip.match(/<span class="reading" data-reading="[a-z-]+"/g) ?? [];
    expect(readings).toEqual(['<span class="reading" data-reading="context"', '<span class="reading" data-reading="five-hour"']);
    expect(chip.match(/<ContextDial/g)?.length).toBe(2);
    expect(chip.match(/size=\{14\}/g)?.length).toBe(2);
    expect(chip).not.toMatch(/gbar/);
  });

  it("names each reading in its own hover", () => {
    expect(chip).toMatch(/data-reading="context" use:tip=\{gaugeTip\}/);
    expect(chip).toMatch(/data-reading="five-hour" use:tip=\{planTip\}/);
    expect(topBar).toMatch(/`Context \$\{tokens\(gauge\.used\)\} of \$\{tokens\(gauge\.limit\)\}/);
    expect(topBar).toMatch(/`5-hour window \$\{plan\.five_hour\}%/);
  });

  it("keeps the chip's click and leaves Classic alone", () => {
    expect(chip).toMatch(/onclick=\{toggleGauge\}/);
    expect(topBarClassic).not.toMatch(/data-reading=/);
  });
});
