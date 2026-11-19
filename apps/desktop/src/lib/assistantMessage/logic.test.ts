// Item 856: AssistantMessage.svelte (Jarvis) and AssistantMessageClassic.svelte
// share `assistantMessage/logic.svelte.ts`. A behaviour added to one look only
// fails here: either as script in the component (it belongs in the logic) or
// as a logic member one look binds and the other does not.
import { describe, expect, it } from "vitest";
import jarvis from "../AssistantMessage.svelte?raw";
import classic from "../AssistantMessageClassic.svelte?raw";
import { twinDrift, twinShape } from "../../test/twins";

/** Members only one look binds, on purpose: its look, not its behaviour.
 *  Classic draws the trace's facts as words (who answers, the live clock and
 *  speed, each step's time, a helper's context, the turn's elapsed time) but
 *  not Jarvis's trace look. */
const JARVIS_ONLY = [
  // Item 564: the trace's numbered rows and each step's bar in the turn.
  "stepNo",
  "barFor",
  "barTitle",
  "timed",
  // Item 564: the stream speed's sparkline (Classic shows the figure alone).
  "spark",
  // Items 589, 610, 616, 667: the running step's motion and its ease-in.
  "motion",
  "rampThink",
  "rampTool",
  // Item 700: the edge light while the turn waits on its agents; Classic
  // takes the "waiting on 2 agents" label alone.
  "waitAgents",
];
const CLASSIC_ONLY: string[] = [];

describe("856: the AssistantMessage twins share one logic", () => {
  const J = twinShape(jarvis);
  const C = twinShape(classic);

  it("each component's script is imports, $props() and the logic call — nothing else", () => {
    expect(J.stray).toEqual([]);
    expect(C.stray).toEqual([]);
  });

  it("both looks bind the same logic members", () => {
    expect(J.bindings.size).toBeGreaterThan(50);
    expect(twinDrift(J.bindings, C.bindings, [...JARVIS_ONLY, ...CLASSIC_ONLY])).toEqual({ onlyA: [], onlyB: [] });
  });

  it("the look-only lists name members that really are one look's only", () => {
    for (const m of JARVIS_ONLY) expect([J.bindings.has(m), C.bindings.has(m)]).toEqual([true, false]);
    for (const m of CLASSIC_ONLY) expect([J.bindings.has(m), C.bindings.has(m)]).toEqual([false, true]);
  });
});
