// Item 821 — diagram blocks in markdown. The suite runs in node with no DOM: the renderer, the sanitiser's text
// pass, the sizes and the kept toggle are tested here; the drawing itself (Mermaid in its frame, the <img>) is
// proven in WebKit by the harness (nightshift-code notes/runner-design/821-shots).
import { beforeEach, describe, expect, it } from "vitest";
import { Marked } from "marked";
import { diagramBlock, diagramFence, diagramOf, mermaidError, sanitizeSvg, sourceKey, stripSvgActive, svgPicture, svgSize } from "./diagramBlock";
import { streamingTail } from "./markdown";
import { VIEW_STATE_KEY, resetViewState, viewGet, viewSet } from "./viewState";
import liveSrc from "./liveHtml.ts?raw";
import mainSrc from "../main.ts?raw";
import remoteMainSrc from "../remote/main.ts?raw";
import markdownSrc from "./markdown.ts?raw";
import promptSrc from "../../../../crates/nightloom-service/src/prompt.rs?raw";
import { mermaidConfig, FALLBACK_THEME } from "./pageKit";
import { placeholdersIn } from "./diagrams";
import diagramsSrc from "./diagrams.ts?raw";
import noteEditorSrc from "./noteEditor.ts?raw";

const md = new Marked();
md.use(diagramBlock);
const render = (src: string) => md.parse(src, { async: false, gfm: true }) as string;

/** A stand-in for an element: just the attributes `diagramOf` reads. */
const fakeEl = (html: string) => {
  const attrs: Record<string, string> = {};
  for (const m of html.matchAll(/(data-[\w-]+)="([^"]*)"/g)) attrs[m[1]] = m[2].replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  return { getAttribute: (n: string) => attrs[n] ?? null } as unknown as Element;
};

const FLOW = "graph TD\n  A[Start] --> B{Ok?}\n  B -->|yes| C[Done]";

describe("the fences", () => {
  it("```mermaid (and mmd) and ```svg are diagrams; others are not", () => {
    expect(diagramFence("mermaid")).toBe("mermaid");
    expect(diagramFence("MMD")).toBe("mermaid");
    expect(diagramFence("svg")).toBe("svg");
    expect(diagramFence("svg title")).toBe("svg");
    expect(diagramFence("html")).toBeNull();
    expect(diagramFence("html page")).toBeNull();
    expect(diagramFence("")).toBeNull();
    expect(diagramFence(undefined)).toBeNull();
  });
  it("a closed block is a placeholder that still holds its code block (never blank, Source is that code)", () => {
    const html = render("```mermaid\n" + FLOW + "\n```\n");
    expect(html).toMatch(/^<div class="md-diagram" data-diagram="mermaid" data-diagram-src="[^"]+"><pre><code class="language-mermaid">graph TD/);
    expect(html).toContain("A[Start] --&gt; B{Ok?}");
    const d = diagramOf(fakeEl(html))!;
    expect(d.kind).toBe("mermaid");
    expect(d.src).toBe(FLOW);
  });
  it("a plain code block is left alone", () => {
    expect(render("```js\n1\n```\n")).toBe('<pre><code class="language-js">1\n</code></pre>\n');
  });
});

describe("streaming: source until the fence closes", () => {
  it("an open fence renders as plain code, the closed one as the diagram", () => {
    const open = "Here:\n\n```mermaid\ngraph TD\n  A --> B";
    expect(render(open)).not.toContain("md-diagram");
    expect(render(open)).toContain('<code class="language-mermaid">graph TD');
    expect(render(open + "\n```")).toContain('class="md-diagram"');
  });
  it("the streaming tail leaves an open fence whole", () => {
    const open = "```mermaid\ngraph TD\n  A --> **B";
    expect(streamingTail(open)).toBe(open);
  });
  it("a fence closed by a longer run is closed; a shorter one is not", () => {
    expect(render("````svg\n<svg/>\n```\n")).not.toContain("md-diagram");
    expect(render("```svg\n<svg/>\n````\n")).toContain("md-diagram");
  });
});

describe("SVG sanitising: nothing in a block runs", () => {
  const evil =
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" onload="alert(1)">` +
    `<script>window.top.pwned = 1</script><SCRIPT type="text/javascript">alert(2)</SCRIPT>` +
    `<rect width="120" height="60" fill="#ffb454" onclick='alert(3)' onmouseover=alert(4) />` +
    `<foreignObject width="10" height="10"><iframe src="https://example.com"></iframe></foreignObject>` +
    `<a href="javascript:alert(5)"><text x="4" y="30">hi</text></a>` +
    `<image href="https://example.com/track.png" width="1" height="1"/>` +
    `<use href="#r"/><scr<script></script>ipt>alert(6)</script></svg>`;
  it("strips every <script>, every on… handler, <foreignObject>, and outside links", () => {
    const out = stripSvgActive(evil);
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/\son[a-z]+\s*=/i);
    expect(out).not.toMatch(/foreignObject|iframe/i);
    expect(out).not.toMatch(/javascript:/i);
    expect(out).not.toContain("example.com");
    expect(out).toContain('<use href="#r"/>');
    expect(out).toContain('<rect width="120" height="60" fill="#ffb454" />');
  });
  it("the picture's URL holds none of it either, and is an image (never a document)", () => {
    const p = svgPicture(evil)!;
    expect(p.url.startsWith("data:image/svg+xml;")).toBe(true);
    const text = decodeURIComponent(p.url.slice(p.url.indexOf(",") + 1));
    expect(text).not.toMatch(/<script|onload|onclick|onmouseover/i);
    // What is left of the spliced tag is inert text inside the drawing, not a script.
    expect(text).not.toMatch(/alert\([1-5]\)/);
    expect(p.width).toBe(120);
    expect(p.height).toBe(60);
  });
  it("an attribute after `/` (`<svg/onload=…>`, `<use/href=…>`) is stripped too (review)", () => {
    const out = stripSvgActive(`<svg/onload=alert(1) width="4"><use/href="https://example.com/x.svg#a"/><use/xlink:href='//evil/y'/></svg>`);
    expect(out).not.toMatch(/onload|example\.com|evil/);
    expect(out).toContain('width="4"');
  });
  it("a block with no <svg> is not a picture; a missing namespace is put back", () => {
    expect(sanitizeSvg("<p>no</p>")).toBeNull();
    expect(sanitizeSvg('<svg viewBox="0 0 10 10"><circle r="4"/></svg>')).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  });
});

describe("sizes", () => {
  it("width and height, else the viewBox, else Mermaid's max-width with the viewBox's ratio", () => {
    expect(svgSize('<svg width="200" height="100">')).toEqual({ width: 200, height: 100 });
    expect(svgSize('<svg viewBox="0 0 300 150">')).toEqual({ width: 300, height: 150 });
    expect(svgSize('<svg width="100%" style="max-width: 640px;" viewBox="0 0 640 320">')).toEqual({ width: 640, height: 320 });
    expect(svgSize("<svg>")).toEqual({ width: null, height: null });
  });
});

describe("a parse failure says why", () => {
  it("keeps the message, drops the caret art", () => {
    expect(mermaidError("Parse error on line 2:\n...A --> \n-----^\nExpecting 'NODE_STRING', got 'EOF'")).toBe(
      "Parse error on line 2: — ...A --> — Expecting 'NODE_STRING', got 'EOF'",
    );
    expect(mermaidError("")).toBe("Mermaid could not read this block");
  });
});

describe("the Diagram / Source choice is kept (his rule: every view keeps its state)", () => {
  let disk: { m: Map<string, string>; getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
  beforeEach(() => {
    const m = new Map<string, string>();
    disk = { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
    resetViewState(disk as never);
  });
  it("per block, by its content, across a reload", () => {
    const d = diagramOf(fakeEl(render("```mermaid\n" + FLOW + "\n```\n")))!;
    expect(viewGet(sourceKey(d.key), false)).toBe(false);
    viewSet(sourceKey(d.key), true, false);
    expect(disk.m.get(VIEW_STATE_KEY)).toContain("diagram.source:");
    resetViewState(disk as never);
    expect(viewGet(sourceKey(d.key), false)).toBe(true);
    // The same text in another reply (a rewind's copy) shares the choice; another block does not.
    const other = diagramOf(fakeEl(render("```mermaid\ngraph LR\n  X --> Y\n```\n")))!;
    expect(viewGet(sourceKey(other.key), false)).toBe(false);
  });
});

describe("wiring (the whole class)", () => {
  it("every markdown renderer draws the fence: notes and file tabs, replies, the phone", () => {
    expect(markdownSrc.match(/\.use\(diagramBlock\)/g)?.length).toBe(3);
    expect(markdownSrc).toContain("marked.use(diagramBlock)");
    expect(markdownSrc).toContain("replyMarked.use(diagramBlock)");
    expect(markdownSrc).toContain("phoneMarked.use(diagramBlock)");
  });
  it("both windows draw diagrams; the patcher leaves a drawing alone", () => {
    expect(mainSrc).toContain("installDiagrams(");
    expect(remoteMainSrc).toContain("installDiagrams(");
    expect(liveSrc).toContain('n.classList.contains("md-diagram-mount")');
  });
  it("Mermaid is strict, and draws labels as SVG text for the picture", () => {
    const c = mermaidConfig(FALLBACK_THEME, false, true);
    expect(c.securityLevel).toBe("strict");
    expect(c.startOnLoad).toBe(false);
    expect(c.htmlLabels).toBe(false);
    expect(mermaidConfig(FALLBACK_THEME, true).securityLevel).toBe("strict");
  });
  it("the model is told the two fences, beside the page note", () => {
    const note = /pub const DIAGRAM_NOTE: &str = "([^\n]*)";/.exec(promptSrc)![1];
    expect(note).toContain("```mermaid");
    expect(note).toContain("```svg");
  });
});

describe("the watcher costs nothing where there is no diagram (review)", () => {
  /** A stand-in node: its type, classes and the placeholders under it. */
  const node = (type: number, cls: string[] = [], under: string[] = [], kids = under.length > 0) =>
    ({
      nodeType: type,
      classList: { contains: (c: string) => cls.includes(c) },
      firstElementChild: kids ? {} : null,
      getElementsByClassName: (c: string) => (c === "md-diagram" ? under : []),
    }) as unknown as Node;
  it("text (a streaming chunk, a keystroke) and elements with no placeholder give none", () => {
    expect(placeholdersIn([node(3), node(3)])).toEqual([]);
    expect(placeholdersIn([node(1, ["md-diagram-mount"], [], true), node(1, ["ta-mirror"])])).toEqual([]);
  });
  it("a placeholder added, or inside what was added, is found", () => {
    const ph = node(1, ["md-diagram"]);
    expect(placeholdersIn([ph])).toEqual([ph]);
    expect(placeholdersIn([node(1, ["markdown"], ["a", "b"] as unknown as string[])])).toEqual(["a", "b"]);
  });
  it("a mutation draws only what arrived; the document is scanned at start and on a theme change only", () => {
    expect(diagramsSrc).toContain("placeholdersIn(r.addedNodes)");
    expect(diagramsSrc.match(/dressAll\(document, opts\)/g)?.length).toBe(1);
  });
  it("a slow or stopped renderer is not kept as the block's answer", () => {
    expect(diagramsSrc).toContain("drawn.delete(drawKey)");
  });
  it("the note editor measures again when a drawn block changes height", () => {
    expect(noteEditorSrc).toContain("new ResizeObserver(() => view.requestMeasure())");
  });
});
