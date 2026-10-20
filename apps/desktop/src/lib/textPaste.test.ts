import { describe, expect, it } from "vitest";
import { pasteSteps, textPastePlan } from "./textPaste";
import { BoxHistory } from "./boxHistory";
import { splitFences } from "./codeDetect";
import katexInline from "./__fixtures__/katex-inline-0xac.html?raw";

// Item 399: the edit box of one of his messages reads a paste with the
// composer's own plan, so pasted code lands fenced there too and the
// edited message is drawn as a freshly sent one.

const CODE = [
  "export function clamp(n: number, lo: number, hi: number): number {",
  "  if (lo > hi) throw new Error(`bad range ${lo}..${hi}`);",
  "  const x = Math.max(lo, n);",
  "  return Math.min(hi, x);",
  "}",
  "",
  "const values = [3, 9, -2].map((v) => clamp(v, 0, 5));",
  "console.log(values);",
].join("\n");


describe("textPastePlan", () => {
  it("code becomes a fenced paste with its language", () => {
    const p = textPastePlan({ plain: CODE, html: "", fileCount: 0, text: "Here is my code:\n", caret: 17 });
    expect(p.kind).toBe("code");
    if (p.kind === "code") expect(p.lang).toBe("typescript");
  });
  it("VS Code's HTML flavour beside it changes nothing: still code", () => {
    const html = `<meta charset='utf-8'><div style="white-space: pre;">${CODE.split("\n").map((l) => `<div><span>${l}</span></div>`).join("")}</div>`;
    expect(textPastePlan({ plain: CODE, html, fileCount: 0, text: "", caret: 0 }).kind).toBe("code");
  });
  it("CRLF from the clipboard comes in as LF", () => {
    const p = textPastePlan({ plain: CODE.replace(/\n/g, "\r\n"), html: "", fileCount: 0, text: "", caret: 0 });
    expect(p.kind === "code" && p.raw).toBe(CODE);
  });
  it("prose stays the browser's paste", () => {
    expect(textPastePlan({ plain: "Thanks, that worked. Can you also check the other file?", html: "", fileCount: 0, text: "", caret: 0 }).kind).toBe("plain");
  });
  it("inside a fence already there, code is not fenced again", () => {
    const text = "```ts\n\n```";
    expect(textPastePlan({ plain: CODE, html: "", fileCount: 0, text, caret: 6 }).kind).toBe("plain");
  });
  it("math from a web page wins over the plain text (item 348)", () => {
    const p = textPastePlan({ plain: "0x A C AC", html: katexInline, fileCount: 0, text: "", caret: 0 });
    expect(p).toEqual({ kind: "math", text: "What is 16-bit representation of $0xAC$ in hex?" });
  });
  it("files are not a text paste", () => {
    expect(textPastePlan({ plain: CODE, html: "", fileCount: 1, text: "", caret: 0 }).kind).toBe("files");
  });
});

describe("pasteSteps (the edit box's textarea, and the composer's)", () => {
  it("fences the paste at the caret in two steps, the first the paste as it came", () => {
    const steps = pasteSteps("Here is my code:\n", 17, 17, CODE, "typescript");
    expect(steps.map((s) => s.text)).toEqual(["Here is my code:\n" + CODE, "Here is my code:\n```typescript\n" + CODE + "\n```"]);
    expect(steps[1].caret).toBe(steps[1].text.length);
  });
  it("⌘Z after it, through the box's history, gives back the raw paste, then the text before", () => {
    const h = new BoxHistory("Here is my code:");
    h.before({ text: "Here is my code:", start: 16, end: 16 });
    h.input("type", { text: "Here is my code:\n", start: 17, end: 17 });
    h.select(17, 17);
    for (const st of pasteSteps("Here is my code:\n", 17, 17, CODE, "typescript")) h.external(st.text, st.caret);
    expect(h.undo()?.text).toBe("Here is my code:\n" + CODE);
    expect(h.undo()?.text).toBe("Here is my code:\n");
    expect(h.redo()?.text).toBe("Here is my code:\n" + CODE);
  });
  it("mid-line, the fence opens and closes on lines of its own", () => {
    const steps = pasteSteps("see: and after", 5, 5, "x = 1\ny = 2\nprint(x + y)", "python");
    expect(steps[1].text).toBe("see: \n```python\nx = 1\ny = 2\nprint(x + y)\n```\nand after");
  });
  it("the edited message is drawn as one code block, as a sent one is", () => {
    const steps = pasteSteps("Here is my code:\n", 17, 17, CODE, "typescript");
    const parts = splitFences(steps[1].text);
    expect(parts.map((p) => p.kind)).toEqual(["text", "code"]);
    expect(parts[1].kind === "code" && parts[1].code).toBe(CODE);
  });
  it("without a language, one step replacing the selection (math, text with images)", () => {
    expect(pasteSteps("a SEL b", 2, 5, "$x$")).toEqual([{ text: "a $x$ b", caret: 5 }]);
  });
});
