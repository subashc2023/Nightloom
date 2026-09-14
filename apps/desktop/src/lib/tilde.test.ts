import { Marked } from "marked";
import { describe, expect, it } from "vitest";
import { tilde } from "./tilde";

// A bare instance with the extension, as math.test.ts does: `renderMarkdown`
// sanitises through DOMPurify, which needs a DOM this environment lacks.
function render(src: string): string {
  const m = new Marked();
  m.use(tilde);
  return m.parse(src, { async: false, gfm: true }) as string;
}

describe("a single tilde is a character, two are a strike", () => {
  it("leaves two approximations in one paragraph alone", () => {
    const html = render("he puts this at ~70%. Then a stage (~10-20% conditional).");
    expect(html).not.toContain("<del>");
    expect(html).toContain("~70%");
    expect(html).toContain("(~10-20%");
  });
  it("still strikes the double form, with inline markup inside", () => {
    expect(render("old ~~was **wrong**~~ now")).toContain("<del>was <strong>wrong</strong></del>");
  });
  it("does not strike across a lone tilde next to a double", () => {
    const html = render("~~struck~~ and ~5% left");
    expect(html).toContain("<del>struck</del>");
    expect(html).toContain("~5% left");
  });
  it("without the extension the bug is real", () => {
    const plain = new Marked().parse("at ~70% and (~10%", { async: false, gfm: true }) as string;
    expect(plain).toContain("<del>");
  });
});
