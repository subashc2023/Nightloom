// Item 856: UserBubble.svelte (Jarvis) and UserBubbleClassic.svelte share
// `userBubble/logic.svelte.ts`. A behaviour added to one look only fails here:
// either as script in the component (it belongs in the logic) or as a logic
// member one look binds and the other does not.
import { describe, expect, it } from "vitest";
import jarvis from "../UserBubble.svelte?raw";
import classic from "../UserBubbleClassic.svelte?raw";
import { twinDrift, twinShape } from "../../test/twins";

describe("856: the UserBubble twins share one logic", () => {
  const J = twinShape(jarvis);
  const C = twinShape(classic);

  it("each component's script is imports, $props() and the logic call — nothing else", () => {
    expect(J.stray).toEqual([]);
    expect(C.stray).toEqual([]);
  });

  it("both looks bind the same logic members", () => {
    expect(J.bindings.size).toBeGreaterThan(15);
    expect(twinDrift(J.bindings, C.bindings)).toEqual({ onlyA: [], onlyB: [] });
  });
});
