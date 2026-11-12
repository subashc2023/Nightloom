import { describe, expect, it } from "vitest";
import { loadAsides, serializeAsides } from "./asides";
import { asideEvents } from "./asideTranscript";
import { estimateView } from "./replyUsage";
import type { Aside, AsideTurn } from "./state.svelte";

/** Item 674 follow-up: an aside's answer shows its share of the plan in the shared footer. */
const turn = (over: Partial<AsideTurn> = {}): AsideTurn => ({
  seq: 1,
  question: "Why only on success?",
  partial: "Because.",
  answer: "Because.",
  error: null,
  cancelled: false,
  cacheRead: 0,
  usage: { input_tokens: 100, output_tokens: 20 },
  ...over,
});
const aside = (t: AsideTurn): Aside => ({ id: 1, quote: null, draft: false, turns: [t], anchor: null });

describe("674: an aside's plan use", () => {
  it("estimateView says the estimate, marked ≈, and why there is no measured rise", () => {
    const v = estimateView({ five_hour: 0.42, seven_day: 0.03, replies: 37 }, 0.31)!;
    expect(v.text).toBe("5h ≈+0.4% · week ≈<0.1%");
    expect(v.title).toMatch(/\$0\.31/);
    expect(v.title).toMatch(/37 chat replies/);
    expect(v.title).toMatch(/no plan readings of its own/);
    expect(estimateView(null, 0.3)).toBeNull();
    expect(estimateView({ five_hour: null, seven_day: null, replies: 40 }, 0.3)).toBeNull();
  });

  it("asideEvents puts it on the reply's event index", () => {
    const ev = asideEvents(aside(turn({ planEst: { five_hour: 1.2, seven_day: 0.2, replies: 30 }, added: 0.5 })));
    expect([...ev.planUse.keys()]).toEqual([1]);
    expect(ev.planUse.get(1)!.text).toBe("5h ≈+1.2% · week ≈+0.2%");
    expect(asideEvents(aside(turn())).planUse.size).toBe(0);
  });

  it("the store keeps it across a relaunch", () => {
    const a = aside(turn({ planEst: { five_hour: 1.2, seven_day: null, replies: 30 } }));
    const back = loadAsides({ getItem: () => serializeAsides(new Map([["c", [a]]])) }).get("c")![0]!;
    expect(back.turns[0]!.planEst).toEqual({ five_hour: 1.2, seven_day: null, replies: 30 });
  });
});
