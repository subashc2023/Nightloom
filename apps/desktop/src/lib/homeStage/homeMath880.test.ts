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

  // Item 991 (2026-11-25): ~~every card text through MathText~~ — MathText draws text as typed, so the model's
  // markdown showed raw. Model-written lines now go through InlineMd (inline markdown, formulas still typeset by
  // the same `math` extension), a brief's section through renderReply; his own words (task.why) stay MathText.
  // The rendered forms are tested in homeMarkdown991.dom.test.ts.
  it("draws every model-written card text with its markdown and maths", () => {
    const cases: [string, string[]][] = [
      [briefSrc, ["{@html renderReply(s.body)}"]],
      [todoSrc, ["<InlineMd text={i.text} />", '<InlineMd text={i.result || "Done by Home"} />']],
      [researchSrc, ["<InlineMd text={r.question || task.why || task.name} />", "<InlineMd text={c.text} />", "<InlineMd text={a.text} />", "<InlineMd text={o.text} />", "<InlineMd text={o.answered} />"]],
      [triageSrc, ["<InlineMd text={cd.question} />"]],
      [watchSrc, ["<InlineMd text={n.title} />"]],
      [runSrc, ["<InlineMd text={s.name} />", "<MathText text={task.why} />", "<InlineMd text={r.asks} />"]],
      [detailSrc, ["<dd style:--i={i}><InlineMd text={v} /></dd>"]],
    ];
    for (const [src, wants] of cases) for (const w of wants) expect(src).toContain(w);
    expect(todoSrc.match(/<InlineMd text=\{i\.text\} \/>/g)).toHaveLength(2);
    // The raw forms are gone.
    expect(briefSrc).not.toContain("use:reveal>{s.body}</div>");
    expect(todoSrc).not.toContain('<span class="d-t">{i.text}</span>');
  });
});
