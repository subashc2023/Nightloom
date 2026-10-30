// Item 480 — liveHtml's patch put maths in the middle of a word ("bec" [Y] ".omes").
// The suite runs in node with no DOM library, so this file stands up the few
// DOM calls `patch` makes (a test-only stand-in, not a parser): trees are built
// by hand as renderReply's would be. The every-offset sweep through the real
// renderer is the WebKit harness (nightshift-code notes/runner-design/480-harness).
import { beforeAll, describe, expect, it } from "vitest";

class FNode {
  static TEXT_NODE = 3;
  static ELEMENT_NODE = 1;
  parentNode: FEl | null = null;
  constructor(public nodeType: number) {}
  get nextSibling(): FNode | null {
    const p = this.parentNode;
    if (!p) return null;
    return p.childNodes[p.childNodes.indexOf(this) + 1] ?? null;
  }
}
class FText extends FNode {
  constructor(public data: string) {
    super(3);
  }
  get textContent() {
    return this.data;
  }
  appendData(s: string) {
    this.data += s;
  }
  cloneNode() {
    return new FText(this.data);
  }
  isEqualNode(o: FNode) {
    return o instanceof FText && o.data === this.data;
  }
}
class FEl extends FNode {
  childNodes: FNode[] = [];
  attrs = new Map<string, string>();
  constructor(public tagName: string, cls = "") {
    super(1);
    if (cls) this.attrs.set("class", cls);
  }
  get attributes() {
    return Array.from(this.attrs, ([name, value]) => ({ name, value }));
  }
  getAttribute(n: string) {
    return this.attrs.get(n) ?? null;
  }
  get classList() {
    return { contains: (c: string) => (this.attrs.get("class") ?? "").split(" ").includes(c) };
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get textContent(): string {
    return this.childNodes.map((c) => (c as FText | FEl).textContent).join("");
  }
  insertBefore(n: FNode, ref: FNode | null) {
    if (n.parentNode) n.parentNode.removeChild(n);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(n);
    else this.childNodes.splice(i, 0, n);
    n.parentNode = this;
    return n;
  }
  appendChild(n: FNode) {
    return this.insertBefore(n, null);
  }
  removeChild(n: FNode) {
    this.childNodes.splice(this.childNodes.indexOf(n), 1);
    n.parentNode = null;
    return n;
  }
  cloneNode(): FEl {
    const e = new FEl(this.tagName);
    e.attrs = new Map(this.attrs);
    for (const c of this.childNodes) e.appendChild((c as FText | FEl).cloneNode());
    return e;
  }
  isEqualNode(o: FNode): boolean {
    if (!(o instanceof FEl) || o.tagName !== this.tagName || o.childNodes.length !== this.childNodes.length) return false;
    if (JSON.stringify(o.attributes) !== JSON.stringify(this.attributes)) return false;
    return this.childNodes.every((c, i) => (c as FText | FEl).isEqualNode(o.childNodes[i]));
  }
}

type Kid = string | FEl;
const el = (tag: string, cls: string, ...kids: Kid[]) => {
  const e = new FEl(tag, cls);
  for (const k of kids) e.appendChild(typeof k === "string" ? new FText(k) : k);
  return e;
};
/** KaTeX's inline output, reduced to what matters here: one element holding the glyph. */
const katex = (tex: string) => el("SPAN", "katex", tex);
const p = (...kids: Kid[]) => el("P", "", ...kids);
const root = (...kids: Kid[]) => el("DIV", "", ...kids);

let patch: (live: Node, prev: Node, next: Node) => number;
let shownText: (n: Node) => string;
beforeAll(async () => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.Node = FNode;
  g.Element = FEl;
  g.document = { createTextNode: (s: string) => new FText(s) };
  const m = await import("./liveHtml");
  patch = m.patch;
  shownText = m.shownText;
});

/** The motion's word span (replyMotion wraps an arriving word in place). */
const word = (w: string) => el("SPAN", "rm-w", w);

describe("480: a patched reply reads as a full render", () => {
  it("his case: the run ends in the motion's span, then 'omes $Y$.' arrives in one delta", () => {
    const head = "and that term's input ";
    const prev = root(p(head + "bec"));
    const live = root(p(head, word("bec"))); // as decorated while "bec" inks in
    const next = root(p(head + "becomes ", katex("Y"), "."));
    patch(live as unknown as Node, prev as unknown as Node, next as unknown as Node);
    expect(shownText(live as unknown as Node)).toBe(head + "becomes Y.");
    // The word span survives (a selection in it stays) and the maths follows the word.
    const kids = (live.childNodes[0] as FEl).childNodes;
    expect(kids.map((k) => (k as FText | FEl).textContent)).toEqual([head, "bec", "omes ", "Y", "."]);
  });

  it("his second case: 'means \"if $S = 0$' — the quote and 'if' stay before the maths", () => {
    const prev = root(p(katex("S̄I0"), " means"));
    const live = root(p(katex("S̄I0"), " ", word("means")));
    const next = root(p(katex("S̄I0"), ' means "if ', katex("S=0"), ", pass ", katex("I0"), "."));
    patch(live as unknown as Node, prev as unknown as Node, next as unknown as Node);
    expect(shownText(live as unknown as Node)).toBe('S̄I0 means "if S=0, pass I0.');
  });

  it("a memory link ending the run is held the same way", () => {
    const prev = root(p("see the note"));
    const live = root(p("see the ", el("A", "mem-ref", "note")));
    const next = root(p("see the notes on ", katex("x"), " here"));
    patch(live as unknown as Node, prev as unknown as Node, next as unknown as Node);
    expect(shownText(live as unknown as Node)).toBe("see the notes on x here");
  });

  it("display maths: a new block after a paragraph whose last word is still inking in", () => {
    const prev = root(p("So the mux is one"));
    const live = root(p("So the mux is ", word("one")));
    const next = root(p("So the mux is one sum:"), el("SPAN", "katex-display", katex("Y=S̄I0+SI1")), p("and"));
    patch(live as unknown as Node, prev as unknown as Node, next as unknown as Node);
    expect(shownText(live as unknown as Node)).toBe("So the mux is one sum:Y=S̄I0+SI1and");
  });

  it("every split of a word before inline maths, with the run's tail wrapped", () => {
    const full = "input becomes ";
    for (let k = 1; k < full.length; k++) {
      const was = full.slice(0, k);
      const m = /(\S+)$/.exec(was);
      const prev = root(p(was));
      const live = m ? root(p(was.slice(0, m.index), word(m[1]))) : root(p(was));
      const next = root(p(full, katex("Y"), "."));
      patch(live as unknown as Node, prev as unknown as Node, next as unknown as Node);
      expect(shownText(live as unknown as Node), `split at ${k}`).toBe(full + "Y.");
    }
  });
});
