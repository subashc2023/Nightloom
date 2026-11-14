import { describe, expect, it } from "vitest";
import providerRail from "./ProviderRail.svelte?raw";
import topBar from "./TopBar.svelte?raw";
import topBarClassic from "./TopBarClassic.svelte?raw";
import rightRailClassic from "./RightRailClassic.svelte?raw";
import settings from "./SettingsModal.svelte?raw";

/*
 * Item 577 (the top bar's "Claude Code · subscription" popover in stage 6's
 * menus grammar). ProviderRail is shared with Classic (RightRailClassic
 * mounts it), so its new rules sit behind the Filament IV gate; TopBar is
 * Filament IV only (Classic mounts TopBarClassic, untouched).
 */
const GATE = ':global(:where(:root:not([data-layout="classic"])))';

/** Selectors of the CSS from the item's marker comment to `</style>`. */
function selectors(src: string, marker: string): string[] {
  const at = src.indexOf(marker);
  const open = src.indexOf("*/", at);
  const css = src.slice(open + 2, src.indexOf("</style>", open)).replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  for (const m of css.matchAll(/(^|})\s*([^{}@]+?)\s*\{/g)) {
    const sel = m[2].trim();
    if (!sel || /^(from|to|\d+%)$/.test(sel)) continue;
    out.push(...sel.split(/,\s*\n?\s*/).map((s) => s.trim()));
  }
  return out;
}

describe("577 the engine popover", () => {
  it("ProviderRail: every new rule is gated but the hidden Engine title's default", () => {
    const sels = selectors(providerRail, "Filament IV, item 577");
    expect(sels.length).toBeGreaterThan(20);
    for (const s of sels) {
      // Defaults hidden everywhere and shown by a gated rule: 577's Engine title, and item 612's
      // quiet status line (its class is set only under Filament), sub-titles and "Nightloom handles" list.
      if ([".eng-h", ".status.quiet", ".grp-h", ".managed-list"].includes(s)) continue;
      expect(s.startsWith(GATE), s).toBe(true);
    }
    expect(providerRail).toMatch(/\.eng-h \{\s*display: none;/);
  });
  it("the Engine title is hidden from screen readers (the radiogroup keeps its label)", () => {
    // Item 612 put a focusable `?` in the title, so it can no longer be aria-hidden; the radiogroup keeps its label.
    expect(providerRail).toMatch(/class="sect-h eng-h"/);
    expect(providerRail).toMatch(/class="eng" role="radiogroup" aria-label="Engine"/);
  });
  it("TopBar carries the popover's look; Classic's files do not", () => {
    expect(topBar).toContain("Item 577");
    expect(topBarClassic).not.toContain("577");
    expect(rightRailClassic).not.toContain("577");
  });
});

describe("576 the Stop button's shape choices", () => {
  it("each choice is a flex row centring the swatch and the name", () => {
    expect(settings).toMatch(/class="stop-choice"\s+class:on=\{stopPref\.shape === sh\.id\}/);
    expect(settings).toMatch(/\.seg button\.stop-choice \{\s*display: inline-flex;\s*align-items: center;/);
  });
});
