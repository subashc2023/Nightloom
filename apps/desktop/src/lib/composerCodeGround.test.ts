import { describe, expect, it } from "vitest";
import type { EditorView, RectangleMarker } from "@codemirror/view";
import { codeGrounds, composerTheme } from "./composerEditor";

// Item 652 (his bug 2026-11-11): a double-clicked word inside a code block in
// the formatted box was selected but showed no highlight. CodeMirror draws
// the selection in a layer under the text, and the code grounds were the
// lines' own backgrounds, painted over it. The grounds are now a layer of
// their own under the selection's; these pin both halves.

/** Every CSS rule `composerTheme` carries, as text. */
function themeCss(): string {
  const out: string[] = [];
  const walk = (x: unknown) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (x && typeof x === "object") {
      const o = x as { getRules?: () => string; value?: unknown; inner?: unknown };
      if (typeof o.getRules === "function") out.push(o.getRules());
      if ("value" in o) walk(o.value);
      if ("inner" in o) walk(o.inner);
    }
  };
  walk(composerTheme);
  return out.join("\n");
}

describe("the code grounds sit under the selection (item 652)", () => {
  it("no code element paints its own ground any more", () => {
    const css = themeCss();
    expect(css).toContain("cm-ccodeblock");
    const own = css.split("\n").filter((r) => /\.cm-ccode(block)?\b[^{]*\{/.test(r) && !r.includes("cm-ccodeground"));
    expect(own.length).toBeGreaterThan(0);
    for (const r of own) expect(r).not.toMatch(/background/);
    expect(css).toMatch(/\.cm-ccodegrounds \.cm-ccodeground\s*\{[^}]*background:\s*var\(--well\)/);
  });

  it("is a layer below the text, like the selection's", () => {
    expect(codeGrounds.above).toBe(false);
  });

  it("draws one ground per code line box and per inline-code fragment, in scroller coordinates", () => {
    const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height });
    const el = (cls: string, rects: ReturnType<typeof rect>[]) => ({
      classList: { contains: (c: string) => cls.split(" ").includes(c) },
      getClientRects: () => rects,
    });
    const view = {
      scaleX: 1,
      scaleY: 1,
      scrollDOM: { getBoundingClientRect: () => rect(100, 50, 600, 300), scrollLeft: 0, scrollTop: 20 },
      contentDOM: {
        querySelectorAll: () => [
          el("cm-line cm-ccodeblock", [rect(110, 80, 580, 22)]),
          el("cm-ccode", [rect(400, 120, 40, 20), rect(110, 142, 30, 20)]),
          el("cm-ccode", [rect(0, 0, 0, 0)]),
        ],
      },
    } as unknown as EditorView;
    const m = codeGrounds.markers(view) as RectangleMarker[];
    // `className` is private in CodeMirror's types; read it as data.
    expect(m.map((x) => (x as unknown as { className: string }).className)).toEqual(["cm-ccodeground", "cm-ccodeground cm-ccodeground-inline", "cm-ccodeground cm-ccodeground-inline"]);
    expect([m[0].left, m[0].top, m[0].width, m[0].height]).toEqual([10, 50, 580, 22]);
    expect([m[2].left, m[2].top]).toEqual([10, 112]);
  });
});
