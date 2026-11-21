// Item 856: Sidebar.svelte (Jarvis) and SidebarClassic.svelte share
// `sidebar/logic.svelte.ts`. A behaviour added to one look only fails here:
// either as script in the component (it belongs in the logic) or as a logic
// member one look binds and the other does not.
import { describe, expect, it } from "vitest";
import jarvis from "../Sidebar.svelte?raw";
import classic from "../SidebarClassic.svelte?raw";
import { twinDrift, twinShape } from "../../test/twins";

/** Members only one look binds, on purpose: its look, not its behaviour. */
const JARVIS_ONLY: string[] = [
  // Item 534 (Filament IV stage 3): the list cut by day under ruled
  // headings; Classic keeps one undated list. Its rows gained 534's and
  // 597's facts (size, tools, hover, hand-off cue) plainly.
  "sections",
];
const CLASSIC_ONLY: string[] = [];

describe("856: the Sidebar twins share one logic", () => {
  const J = twinShape(jarvis);
  const C = twinShape(classic);

  it("each component's script is imports, $props() and the logic call — nothing else", () => {
    expect(J.stray).toEqual([]);
    expect(C.stray).toEqual([]);
  });

  it("both looks bind the same logic members", () => {
    expect(J.bindings.size).toBeGreaterThan(5);
    expect(twinDrift(J.bindings, C.bindings, [...JARVIS_ONLY, ...CLASSIC_ONLY])).toEqual({ onlyA: [], onlyB: [] });
  });

  it("the look-only lists name members that really are one look's only", () => {
    for (const m of JARVIS_ONLY) expect([J.bindings.has(m), C.bindings.has(m)]).toEqual([true, false]);
    for (const m of CLASSIC_ONLY) expect([J.bindings.has(m), C.bindings.has(m)]).toEqual([false, true]);
  });
});
