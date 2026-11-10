// Item 571 (Filament IV stage 7, Settings): the Usage pane's pure helpers,
// the look choices, and Classic must not change — every rule of the
// Filament IV block in SettingsModal and PromptLibrary is behind the layout
// gate, except the hiders and the classes only Filament IV's markup uses.
import { describe, expect, it } from "vitest";
import settingsModal from "./SettingsModal.svelte?raw";
import promptLibrary from "./PromptLibrary.svelte?raw";
import { paceLine, planDials, resetsWhen, surfaceShares, weekGone } from "./settingsUsage";
import { accentAttr, handoffChoices, parseAccent, parseLight } from "./settings/look.svelte";

const GATE = ':global(:where(:root:not([data-layout="classic"])))';

function selectors(src: string, marker: string): string[] {
  const style = src.slice(src.lastIndexOf("<style>"));
  const at = style.indexOf(marker);
  expect(at).toBeGreaterThan(0);
  const body = style.slice(at, style.lastIndexOf("</style>"));
  // Top-level selector lines: two-space indent, ending in "{" or ",", not a property, not an at-rule.
  return body
    .split("\n")
    .filter((l) => /^ {2}\S/.test(l) && /[{,]\s*$/.test(l) && !l.trim().startsWith("@") && !l.trim().startsWith("/*"));
}

describe("Classic must not change (item 542's rule)", () => {
  it("every SettingsModal Filament IV rule is gated, or a hider, or an IV-only class", () => {
    const allowed = /^ {2}(\.f4-only,|\.done4 \{|\.(pick3|pick2|pick|pick-h|pick-n|pick-sw|radio|d4-row|d4-l|u4|u4-[a-z]+)\b)/;
    const bad = selectors(settingsModal, "Filament IV, stage 7 (item 571").filter((l) => !l.trim().startsWith(GATE) && !allowed.test(l));
    expect(bad).toEqual([]);
  });
  it("every PromptLibrary Filament IV rule is gated", () => {
    const bad = selectors(promptLibrary, "Filament IV, stage 7 (item 571").filter((l) => !l.trim().startsWith(GATE));
    expect(bad).toEqual([]);
  });
  it("Classic keeps the old Plan and Surfaces cards and the close icon", () => {
    expect(settingsModal).toContain("{#if classic()}");
    expect(settingsModal).toContain('<span class="t">Plan</span>');
    expect(settingsModal).toContain('<span class="t">Surfaces</span>');
  });
});

describe("Usage pane helpers", () => {
  it("draws a dial per window with a reading", () => {
    expect(planDials(null)).toEqual([]);
    const d = planDials({ five_hour: 26, seven_day: null });
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ key: "five", value: "26%", unit: "5 hours" });
    expect(d[0].share).toBeCloseTo(0.26);
    expect(planDials({ five_hour: 140, seven_day: 62 })[0].share).toBe(1);
  });
  it("says how much of the week is gone, from the reset", () => {
    const now = Date.parse("2026-11-10T12:00:00Z");
    expect(weekGone(null, now)).toBeNull();
    expect(weekGone("nonsense", now)).toBeNull();
    expect(weekGone(new Date(now + 3.5 * 86_400_000).toISOString(), now)).toBeCloseTo(0.5);
    expect(paceLine(62, 0.43)).toBe("62% used with 43% of the week gone");
    expect(paceLine(null, 0.4)).toBeNull();
  });
  it("splits the week by surface, leaving blanks out", () => {
    const s = surfaceShares({ claude_code_pct: 44, chat_pct: null, cowork_pct: 3, other_pct: 4 });
    expect(s.map((x) => x.key)).toEqual(["claude_code", "cowork", "other"]);
    expect(surfaceShares(null)).toEqual([]);
  });
  it("says the reset in 12-hour time", () => {
    const now = new Date(2026, 10, 10, 12, 0);
    expect(resetsWhen(new Date(2026, 10, 10, 21, 40).toISOString(), now)).toBe("Resets at 9:40 PM");
    expect(resetsWhen(new Date(2026, 10, 13, 0, 0).toISOString(), now)).toBe("Resets Friday 12:00 AM");
    expect(resetsWhen(null, now)).toBeNull();
  });
});

describe("Look choices", () => {
  it("reads unknown values as the defaults", () => {
    expect(parseAccent(null)).toBe("amber");
    expect(parseAccent("weld")).toBe("weld");
    expect(parseAccent("teal")).toBe("amber");
    expect(parseLight("calm")).toBe("calm");
    expect(parseLight(null)).toBe("lit");
  });
  it("stamps no accent for amber or under Classic", () => {
    expect(accentAttr("amber", false)).toBeNull();
    expect(accentAttr("madder", false)).toBe("madder");
    expect(accentAttr("madder", true)).toBeNull();
  });
  it("offers the current hand-off line among the choices", () => {
    expect(handoffChoices(300)).toContain(300);
    expect(handoffChoices(333)).toContain(333);
    const c = handoffChoices(333);
    expect([...c].sort((a, b) => a - b)).toEqual(c);
  });
});
