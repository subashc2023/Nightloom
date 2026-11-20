// Item 880 leftover: Home's cards draw their model-written text through MathText, so LaTeX in a
// brief, a todo, a research claim, a needs-you question or a run step is typeset, and "$5 and $6"
// stays prose (MathText's own reading, `userMath.ts`, unchanged).
import { describe, expect, it } from "vitest";
import { mathParts } from "../userMath";
import briefSrc from "./views/Brief.svelte?raw";
import todoSrc from "./views/Todo.svelte?raw";
import researchSrc from "./views/Research.svelte?raw";
import triageSrc from "./views/Triage.svelte?raw";
import watchSrc from "./views/Watch.svelte?raw";
import runSrc from "./views/Run.svelte?raw";
import detailSrc from "./Detail.svelte?raw";

describe("Home cards' maths (880)", () => {
  it("reads a formula in a card body as maths, and dollar amounts as prose", () => {
    const parts = mathParts("The ratio is $\\frac{a}{b}$ today");
    expect(parts.map((p) => p.kind)).toEqual(["text", "math", "text"]);
    expect(parts[1]).toMatchObject({ kind: "math", tex: "\\frac{a}{b}", display: false });
    expect(mathParts("It costs $5 and $6 a month")).toEqual([{ kind: "text", text: "It costs $5 and $6 a month" }]);
    expect(mathParts("")).toEqual([{ kind: "text", text: "" }]);
  });

  it("draws every card text through MathText", () => {
    const cases: [string, string[]][] = [
      [briefSrc, ["<MathText text={s.body} />"]],
      [todoSrc, ["<MathText text={i.text} />", '<MathText text={i.result || "Done by Home"} />']],
      [researchSrc, ["<MathText text={r.question || task.why || task.name} />", "<MathText text={c.text} />", "<MathText text={a.text} />", "<MathText text={o.text} />", "<MathText text={o.answered} />"]],
      [triageSrc, ["<MathText text={cd.question} />"]],
      [watchSrc, ["<MathText text={n.title} />"]],
      [runSrc, ["<MathText text={s.name} />", "<MathText text={task.why} />", "<MathText text={r.asks} />"]],
      [detailSrc, ["<dd style:--i={i}><MathText text={v} /></dd>"]],
    ];
    for (const [src, wants] of cases) for (const w of wants) expect(src).toContain(w);
    expect(todoSrc.match(/<MathText text=\{i\.text\} \/>/g)).toHaveLength(2);
    // The raw forms are gone.
    expect(briefSrc).not.toContain("use:reveal>{s.body}</div>");
    expect(todoSrc).not.toContain('<span class="d-t">{i.text}</span>');
  });
});
