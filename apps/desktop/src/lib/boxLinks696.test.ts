import { describe, expect, it } from "vitest";
import { findBoxLinks, linkAt, lineLinkSegs } from "./boxLinks";
import { boxDrawing, composerDecorations, composerState, liveSpans } from "./composerEditor";
import { layerShown } from "./BoxLayer.svelte";

/** The links in `t` as [the text they cover, where they open]. */
const links = (t: string) => findBoxLinks(t).map((l) => [t.slice(l.from, l.to), l.href]);

describe("findBoxLinks (item 696: links in the message box)", () => {
  it("finds a bare URL, http and https, mid-sentence", () => {
    expect(links("see https://arxiv.org/abs/2607.27250 for it")).toEqual([
      ["https://arxiv.org/abs/2607.27250", "https://arxiv.org/abs/2607.27250"],
    ]);
    expect(links("http://a.b/c?d=1&e=2#f")).toEqual([["http://a.b/c?d=1&e=2#f", "http://a.b/c?d=1&e=2#f"]]);
  });
  it("opens a bare www. address over https", () => {
    expect(links("go to www.example.com now")).toEqual([["www.example.com", "https://www.example.com"]]);
  });
  it("finds a Markdown [text](url) link as one link over the whole bracket", () => {
    expect(links("read [the paper](https://arxiv.org/abs/1) first")).toEqual([
      ["[the paper](https://arxiv.org/abs/1)", "https://arxiv.org/abs/1"],
    ]);
    expect(links("[mail](mailto:a@b.c)")).toEqual([["[mail](mailto:a@b.c)", "mailto:a@b.c"]]);
  });
  it("keeps balanced parentheses in a URL (Wikipedia) and drops an unbalanced closer", () => {
    expect(links("https://en.wikipedia.org/wiki/Stack_(abstract_data_type)")).toEqual([
      ["https://en.wikipedia.org/wiki/Stack_(abstract_data_type)", "https://en.wikipedia.org/wiki/Stack_(abstract_data_type)"],
    ]);
    expect(links("(see https://a.com/x)")).toEqual([["https://a.com/x", "https://a.com/x"]]);
    expect(links("[w](https://en.wikipedia.org/wiki/A_(b))")).toEqual([
      ["[w](https://en.wikipedia.org/wiki/A_(b))", "https://en.wikipedia.org/wiki/A_(b)"],
    ]);
  });
  it("leaves trailing punctuation out of a bare URL", () => {
    for (const p of [".", ",", ";", ":", "!", "?", "'", '"', "…", "**", "_"]) {
      expect(links(`look at https://a.com/b${p}`)).toEqual([["https://a.com/b", "https://a.com/b"]]);
    }
    expect(links("https://a.com/b.html.")).toEqual([["https://a.com/b.html", "https://a.com/b.html"]]);
    expect(links("<https://a.com/b>")).toEqual([["https://a.com/b", "https://a.com/b"]]);
  });
  it("is not a link inside inline code or a code fence", () => {
    expect(links("run `curl https://a.com/x` then https://b.com")).toEqual([["https://b.com", "https://b.com"]]);
    expect(links("``x https://a.com ``")).toEqual([]);
    expect(links("`[t](https://a.com)`")).toEqual([]);
    expect(links("before\n```sh\ncurl https://a.com\n```\nafter https://c.com")).toEqual([["https://c.com", "https://c.com"]]);
    // An unclosed fence runs to the end, as CommonMark has it.
    expect(links("```\nhttps://a.com")).toEqual([]);
    // A lone backtick is a backtick, not a code span.
    expect(links("it's ` here https://a.com")).toEqual([["https://a.com", "https://a.com"]]);
  });
  it("needs a real scheme or www., and a word boundary before it", () => {
    expect(links("ftp://a.com file:///etc/x javascript:alert(1)")).toEqual([]);
    expect(links("xhttps://a.com")).toEqual([]);
    expect(links("[t](javascript:alert(1)) [u](/relative)")).toEqual([]);
    expect(links("https:// alone")).toEqual([]);
    expect(links("www. nothing")).toEqual([]);
  });
  it("finds several, in order, a link in a quote line too", () => {
    expect(links("> https://a.com and [b](https://b.com)\nhttps://c.com")).toEqual([
      ["https://a.com", "https://a.com"],
      ["[b](https://b.com)", "https://b.com"],
      ["https://c.com", "https://c.com"],
    ]);
  });
});

describe("linkAt and lineLinkSegs (the two boxes' use of the list)", () => {
  it("names the link under an offset, ends included, else null", () => {
    const t = "x https://a.com y";
    const ls = findBoxLinks(t);
    expect(linkAt(ls, 2)?.href).toBe("https://a.com");
    expect(linkAt(ls, 15)?.href).toBe("https://a.com");
    expect(linkAt(ls, 1)).toBeNull();
    expect(linkAt(ls, 16)).toBeNull();
  });
  it("splits one line's text into plain and link pieces that join back to it", () => {
    const t = "a\nsee https://a.com and [b](https://b.com).";
    const ls = findBoxLinks(t);
    const rest = t.split("\n")[1];
    const segs = lineLinkSegs(rest, 2, ls);
    expect(segs.map((s) => s.text).join("")).toBe(rest);
    expect(segs.filter((s) => s.href).map((s) => s.text)).toEqual(["https://a.com", "[b](https://b.com)"]);
    expect(lineLinkSegs("plain", 0, [])).toEqual([{ text: "plain", href: null }]);
  });
});

describe("both boxes draw the links (Format on: CodeMirror; off: the layer)", () => {
  const t = "see https://a.com and `https://code.com` and [b](https://b.com)";
  it("the formatted box has a link span per link, none in code", () => {
    const spans = liveSpans(composerState(t)).filter((s) => s.kind === "link");
    expect(spans.map((s) => [t.slice(s.from, s.to), s.href])).toEqual([
      ["https://a.com", "https://a.com"],
      ["[b](https://b.com)", "https://b.com"],
    ]);
  });
  it("draws them as link marks Format on, and in the plain drawing (a table held, Format off)", () => {
    for (const mode of ["all", "plain"] as const) {
      const set = composerDecorations(composerState(t, [boxDrawing.of(mode)]));
      const found: string[] = [];
      set.between(0, t.length, (from, to, d) => {
        if (d.spec.class === "cm-clink") found.push(`${t.slice(from, to)}|${d.spec.attributes["data-href"]}`);
      });
      expect(found).toEqual(["https://a.com|https://a.com", "[b](https://b.com)|https://b.com"]);
    }
  });
  it("the plain box draws its layer for a link alone, and not for one in code", () => {
    expect(layerShown("plain words")).toBe(false);
    expect(layerShown("go to https://a.com")).toBe(true);
    expect(layerShown("`https://a.com`")).toBe(false);
  });
});
