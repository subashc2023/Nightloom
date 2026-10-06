import { describe, expect, it } from "vitest";
import { codePasteLanguage, detectCode, fenced, findFences, layerLines, splitFences, withFenceLanguage } from "./codeDetect";
import { HIGHLIGHT_MAX_CHARS, htmlToSegments, languageOf, segmentLines, segments } from "./codeHighlight";

export const PY = `def fib(n: int) -> int:
    """Return the n-th Fibonacci number."""
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a

if __name__ == "__main__":
    print([fib(i) for i in range(10)])`;

export const CPP = `#include <iostream>
#include <vector>

int main() {
    std::vector<int> xs{3, 1, 2};
    for (const auto& x : xs) {
        std::cout << x << "\\n";
    }
    return 0;
}`;

export const JAVA = `public class Greeter {
    private final String name;

    public Greeter(String name) {
        this.name = name;
    }

    public static void main(String[] args) {
        System.out.println(new Greeter("world").greet());
    }

    String greet() { return "Hello, " + name + "!"; }
}`;

export const PROSE = `The runner advances its watermark only on success, so a failed unit is redone rather than skipped.
That makes redoing work cheap and skipping it impossible, which is the whole point of the design.
Tomorrow I want to look at whether the review pass should run before or after the morning page.`;

describe("detectCode (item 315)", () => {
  it("finds Python, C++ and Java with the right language", () => {
    expect(detectCode(PY)).toMatchObject({ code: true, lang: "python" });
    expect(detectCode(CPP)).toMatchObject({ code: true, lang: "cpp" });
    expect(detectCode(JAVA)).toMatchObject({ code: true, lang: "java" });
  });
  it("leaves prose as prose", () => {
    expect(detectCode(PROSE).code).toBe(false);
  });
  it("leaves prose with a stray brace or semicolon as prose", () => {
    const t = `I tried the fix you suggested {the one with the cache}; it did not help at all.
The second idea was better, but the test still fails on the third run every single time.`;
    expect(detectCode(t).code).toBe(false);
  });
  it("leaves a markdown list and a single line alone", () => {
    expect(detectCode("- buy milk\n- call mum\n- book the flight for Friday").code).toBe(false);
    expect(detectCode("const x = 1;").code).toBe(false);
  });
  it("leaves a paste that already has fences alone", () => {
    expect(detectCode("```py\nprint(1)\n```").code).toBe(false);
  });
  it("finds JavaScript and Rust", () => {
    const js = `export function add(a, b) {\n  const sum = a + b;\n  console.log(\`sum is \${sum}\`);\n  return sum;\n}`;
    expect(detectCode(js).code).toBe(true);
    const rs = `fn main() {\n    let v: Vec<i32> = vec![1, 2, 3];\n    println!("{:?}", v.iter().map(|x| x * 2).collect::<Vec<_>>());\n}`;
    expect(detectCode(rs)).toMatchObject({ code: true, lang: "rust" });
  });
});

describe("fenced", () => {
  it("puts the fence on lines of its own and keeps the paste", () => {
    expect(fenced("a()\nb()", "python", "", "")).toBe("```python\na()\nb()\n```");
    expect(fenced("a()\nb()", "python", "look: ", "")).toBe("\n```python\na()\nb()\n```");
    expect(fenced("a()\nb()\n", "python", "x\n", "y")).toBe("```python\na()\nb()\n```\n");
    expect(fenced("a()\r\nb()", "c", "", "\nmore")).toBe("```c\na()\nb()\n```");
  });
});

describe("findFences", () => {
  it("reads a closed and an open fence", () => {
    const t = "hi\n```py\nx = 1\n```\nbye\n~~~js\nlet y";
    const f = findFences(t);
    expect(f).toHaveLength(2);
    expect(f[0]).toMatchObject({ open: 1, close: 3, info: "py", lang: "python" });
    expect(t.slice(f[0].bodyFrom, f[0].bodyTo)).toBe("x = 1");
    expect(f[1]).toMatchObject({ open: 5, close: null, info: "js", lang: "javascript" });
    expect(t.slice(f[1].bodyFrom, f[1].bodyTo)).toBe("let y");
  });
  it("an empty body and an unknown language", () => {
    const f = findFences("```zzz\n```");
    expect(f[0]).toMatchObject({ info: "zzz", lang: null, close: 1 });
    expect(f[0].bodyFrom).toBe(f[0].bodyTo);
  });
  it("relabels only the info string", () => {
    const t = "a\n```py\nx = 1\n```";
    const f = findFences(t)[0];
    expect(withFenceLanguage(t, f, "cpp")).toBe("a\n```cpp\nx = 1\n```");
    const bare = "```\nx\n```";
    expect(withFenceLanguage(bare, findFences(bare)[0], "go")).toBe("```go\nx\n```");
  });
});

describe("splitFences (the sent bubble)", () => {
  it("cuts text and blocks", () => {
    expect(splitFences("look:\n```py\nx = 1\n```\nthanks")).toEqual([
      { kind: "text", text: "look:" },
      { kind: "code", code: "x = 1", info: "py", lang: "python" },
      { kind: "text", text: "thanks" },
    ]);
    expect(splitFences("no code")).toEqual([{ kind: "text", text: "no code" }]);
  });
});

describe("highlighting never changes the characters", () => {
  it("segments join back to the input", () => {
    for (const [code, lang] of [[PY, "python"], [CPP, "cpp"], [JAVA, "java"], ["a < b && c > \"d\" & 'e'", "javascript"]]) {
      const segs = segments(code, lang);
      expect(segs.map((s) => s.text).join("")).toBe(code);
      if (code !== segs[segs.length - 1]?.text) expect(segs.some((s) => s.cls.includes("hljs-"))).toBe(true);
    }
  });
  it("an unknown language is one plain run", () => {
    expect(segments("x y", "klingon")).toEqual([{ text: "x y", cls: "" }]);
  });
  it("reads entities and nested spans", () => {
    expect(htmlToSegments('<span class="a">x &lt;<span class="b">y</span></span>&amp;')).toEqual([
      { text: "x <", cls: "a" },
      { text: "y", cls: "a b" },
      { text: "&", cls: "" },
    ]);
  });
  it("cuts runs at line ends", () => {
    const lines = segmentLines([{ text: "a\nb", cls: "k" }, { text: "c\n", cls: "" }]);
    expect(lines).toEqual([[{ text: "a", cls: "k" }], [{ text: "b", cls: "k" }, { text: "c", cls: "" }], []]);
  });
  it("knows the usual aliases", () => {
    expect(languageOf("py")?.id).toBe("python");
    expect(languageOf("c++")?.id).toBe("cpp");
    expect(languageOf("ts")?.id).toBe("typescript");
    expect(languageOf("sh")?.id).toBe("bash");
    expect(languageOf("Java")?.id).toBe("java");
    expect(languageOf("")).toBeNull();
  });
});

describe("codePasteLanguage (the order with item 284)", () => {
  it("fences a code paste", () => {
    expect(codePasteLanguage(PY, "", 0)).toBe("python");
  });
  it("not a long paste: that one gets the attachment offer", () => {
    const long = Array.from({ length: 700 }, (_, i) => `x${i} = compute(${i}, "a b c")`).join("\n");
    expect(codePasteLanguage(long, "", 0)).toBeNull();
  });
  it("not inside a fence already there", () => {
    const t = "```py\n\n```";
    expect(codePasteLanguage(PY, t, 6)).toBeNull();
    expect(codePasteLanguage(PY, t + "\n", t.length + 1)).toBe("python");
  });
  it("not prose", () => {
    expect(codePasteLanguage(PROSE, "", 0)).toBeNull();
  });
});

describe("layerLines", () => {
  it("marks fence lines and colours the body", () => {
    const t = "hi\n```py\ndef f():\n    return 1\n```\nbye";
    const l = layerLines(t);
    expect(l.map((x) => x?.kind ?? null)).toEqual([null, "open", "body", "body", "close", null]);
    const body = l[2];
    expect(body?.kind === "body" && body.segs.map((s) => s.text).join("")).toBe("def f():");
    expect(body?.kind === "body" && body.segs.some((s) => s.cls.includes("hljs-keyword"))).toBe(true);
  });
  it("an open fence colours to the end", () => {
    expect(layerLines("```js\nlet a = 1\nlet b").map((x) => x?.kind ?? null)).toEqual(["open", "body", "body"]);
  });
});

// Review fixes, 2026-10-05.
describe("review fixes", () => {
  it("a Python traceback, if fenced, is labelled Python (highlight.js guessed Java)", () => {
    const t = `Traceback (most recent call last):\n  File "main.py", line 3, in <module>\n    foo()\n  File "main.py", line 2, in foo\n    raise ValueError("x")\nValueError: x`;
    const v = detectCode(t);
    expect(v.code ? v.lang : "python").toBe("python");
  });
  it("a block he is not typing in keeps its very line objects (the layer skips it)", () => {
    const body = "def f():\n    return 1";
    const a = layerLines(`hi\n\`\`\`py\n${body}\n\`\`\`\nbye`);
    const b = layerLines(`hiX\n\`\`\`py\n${body}\n\`\`\`\nbye`);
    expect(b[2]).toBe(a[2]);
    expect(b[3]).toBe(a[3]);
  });
  it("a block past the size cap is drawn plain, its characters unchanged", () => {
    const code = "x = 1\n".repeat(Math.ceil(HIGHLIGHT_MAX_CHARS / 6) + 1);
    const segs = segments(code, "python");
    expect(segs).toEqual([{ text: code, cls: "" }]);
  });
});
