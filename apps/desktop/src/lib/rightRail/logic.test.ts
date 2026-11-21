// Item 856: RightRail.svelte (Jarvis) and RightRailClassic.svelte share
// `rightRail/logic.svelte.ts`. A behaviour added to one look only fails here:
// either as script in the component (it belongs in the logic) or as a logic
// member one look binds and the other does not.
import { describe, expect, it } from "vitest";
import jarvis from "../RightRail.svelte?raw";
import classic from "../RightRailClassic.svelte?raw";
import { twinDrift, twinShape } from "../../test/twins";

/** Members only one look binds, on purpose: its look, not its behaviour. */
const JARVIS_ONLY: string[] = [];
const CLASSIC_ONLY: string[] = [];

describe("856: the RightRail twins share one logic", () => {
  const J = twinShape(jarvis);
  const C = twinShape(classic);

  it("each component's script is imports, $props() and the logic call — nothing else", () => {
    expect(J.stray).toEqual([]);
    expect(C.stray).toEqual([]);
  });

  it("both looks bind the same logic members", () => {
    expect(J.bindings.size).toBeGreaterThan(3);
    expect(twinDrift(J.bindings, C.bindings, [...JARVIS_ONLY, ...CLASSIC_ONLY])).toEqual({ onlyA: [], onlyB: [] });
  });

  it("the look-only lists name members that really are one look's only", () => {
    for (const m of JARVIS_ONLY) expect([J.bindings.has(m), C.bindings.has(m)]).toEqual([true, false]);
    for (const m of CLASSIC_ONLY) expect([J.bindings.has(m), C.bindings.has(m)]).toEqual([false, true]);
  });
});
