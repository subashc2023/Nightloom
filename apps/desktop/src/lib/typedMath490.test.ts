import { describe, expect, it } from "vitest";
import { applyTypedMath, findTypedMath, groupTypedMath, type TypedMathSpan } from "./typedMath";

// Item 490 (his report, 2026-10-31: "the 'show as maths' is losing the
// formatting and line spacing"): a typed-maths offer ran across a line
// break and took the next line's list number (`O(1)⏎4` offered as
// `O(1) 4 → O(1)4`), so accepting it joined two lines of his list. His
// screenshot's draft, before and after an earlier accept.
const HIS =
  "1. push: O(1), pop: O(1), peek O(1)\n2. enqueue: O(1), dequeue: O(1)\n3. O(1), O(1)\n4. worst case is O(n), amortized O(1)\n5. push: O(1) pop: O(n), amortized O(1)\n\n6. ";
const SHOT =
  "1. push: $O (1)$, pop: $O (1)$, peek $O (1)$\n2. enqueue: $O (1)$, dequeue: $O (1)\n3. O(1), O(1)\n4. worst case is O(n), amortized O(1)\n5. push: O(1) pop: O(n), amortized O(1)\n\n6. ";

/** The text with every wrap undone and TeX spacing ignored: what must not change. */
const bareText = (t: string) => t.replace(/\$/g, "").replace(/O \(/g, "O(");
/** Single dollars on a line (not `$$`, not `\$`): an odd count is an unpaired one. */
const singles = (line: string) => (line.match(/(?<![\\$])\$(?!\$)/g) ?? []).length;

function everyWay(text: string): { name: string; out: string }[] {
  const spans = findTypedMath(text);
  return [
    { name: "all", out: applyTypedMath(text, spans).text },
    ...groupTypedMath(spans).map((g) => ({ name: g.span.src, out: applyTypedMath(text, g.all).text })),
  ];
}

describe("item 490: Show as maths keeps his lines", () => {
  for (const [name, text] of [
    ["his text", HIS],
    ["his screenshot", SHOT],
  ] as const) {
    it(`${name}: no offer crosses a line break or takes a list number`, () => {
      for (const s of findTypedMath(text)) {
        expect(s.src).not.toMatch(/\n/);
        expect(s.src).not.toMatch(/^\d+\.|\s\d+$/);
      }
    });
    it(`${name}: every way of accepting keeps every line, list number and blank line`, () => {
      const lines = text.split("\n");
      for (const { name: how, out } of everyWay(text)) {
        const got = out.split("\n");
        expect(got.length, how).toBe(lines.length);
        got.forEach((l, i) => expect(l.match(/^\d+\. |^$/)?.[0], how).toBe(lines[i].match(/^\d+\. |^$/)?.[0]));
        expect(bareText(out), how).toBe(bareText(text));
      }
    });
    it(`${name}: no accept leaves an unpaired dollar`, () => {
      const out = applyTypedMath(text, findTypedMath(text)).text;
      for (const l of out.split("\n")) expect(singles(l) % 2, l).toBe(0);
    });
    it(`${name}: one chip per distinct formula`, () => {
      const g = groupTypedMath(findTypedMath(text));
      const keys = g.map((x) => x.span.src);
      expect(new Set(keys).size).toBe(keys.length);
      expect(g.reduce((n, x) => n + x.count, 0)).toBe(findTypedMath(text).length);
    });
  }

  it("his text: Use maths for all, exactly", () => {
    expect(applyTypedMath(HIS, findTypedMath(HIS)).text).toBe(
      "1. push: $O (1)$, pop: $O (1)$, peek $O (1)$\n2. enqueue: $O (1)$, dequeue: $O (1)$\n3. $O (1)$, $O (1)$\n4. worst case is $O (n)$, amortized $O (1)$\n5. push: $O (1)$ pop: $O (n)$, amortized $O (1)$\n\n6. ",
    );
    expect(groupTypedMath(findTypedMath(HIS)).map((g) => [g.span.src, g.count])).toEqual([
      ["O(1)", 10],
      ["O(n)", 2],
    ]);
  });

  it("his screenshot: the open `$O (1)` is offered closed, and Use maths for all is exact", () => {
    const close = findTypedMath(SHOT).filter((s) => s.close);
    expect(close.map((s) => s.src)).toEqual(["$O (1)"]);
    expect(applyTypedMath(SHOT, findTypedMath(SHOT)).text).toBe(
      "1. push: $O (1)$, pop: $O (1)$, peek $O (1)$\n2. enqueue: $O (1)$, dequeue: $O (1)$\n3. $O (1)$, $O (1)$\n4. worst case is $O (n)$, amortized $O (1)$\n5. push: $O (1)$ pop: $O (n)$, amortized $O (1)$\n\n6. ",
    );
  });

  it("one chip applies to every occurrence; the rest of the text is byte-for-byte", () => {
    const g = groupTypedMath(findTypedMath(HIS)).find((x) => x.span.src === "O(n)")!;
    expect(applyTypedMath(HIS, g.all).text).toBe(HIS.replace(/O\(n\)/g, "$O (n)$"));
  });
});

describe("item 490: the whole class — no maths offer crosses a line", () => {
  const CASES: [string, string[]][] = [
    ["f(x)\n2. g(x)", ["f(x)", "g(x)"]],
    ["x squared\nplus y", ["x squared"]],
    ["the cost is O(n log\nn) here", []],
    ["s^2\n3", ["s^2"]],
    ["2 pi\nr", ["2 pi"]],
    ["1) O(1)\n2) O(n)", ["O(1)", "O(n)"]],
    ["- x + y = 3\n- a^2", ["x + y = 3", "a^2"]],
    ["\\alpha\n4. \\beta", ["\\alpha", "\\beta"]],
    ["x = 1\n\ny = 2", ["x = 1", "y = 2"]],
    ["sum from i=1\nto n", ["i=1"]],
  ];
  for (const [text, want] of CASES)
    it(JSON.stringify(text), () => {
      const got = findTypedMath(text);
      expect(got.map((s) => s.src)).toEqual(want);
      const out = applyTypedMath(text, got).text;
      expect(out.split("\n").length).toBe(text.split("\n").length);
    });
});

describe("item 490: closing an open dollar", () => {
  const close = (t: string) =>
    findTypedMath(t)
      .filter((s: TypedMathSpan) => s.close)
      .map((s) => s.src);
  it("offers only a short maths tail, never prose, a price or a pair", () => {
    expect(close("dequeue: $O (1)")).toEqual(["$O (1)"]);
    expect(close("so $x^2 + 1.")).toEqual(["$x^2 + 1"]);
    expect(close("it costs $5 a month")).toEqual([]);
    expect(close("we know $a$ and $b$ here")).toEqual([]);
    expect(close("I paid $ for the thing and then some more")).toEqual([]);
    expect(close("the $ sign is a dollar")).toEqual([]);
    expect(close("run `echo $HOME`")).toEqual([]);
    expect(close("$$x$$")).toEqual([]);
  });
});
