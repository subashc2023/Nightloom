/**
 * Item 880 (his "for the millionth time of this same repeated issue latex
 * doesnt format", 2026-11-19): every place that draws words from a reply, a
 * note or his message draws them through the one maths renderer — `MathText`
 * (`userMath.ts`) for plain words, `renderReply` / `renderMarkdown` for a
 * passage — never as a bare text node.
 *
 * The guard: every `.svelte` file under `src/` is scanned for text-node
 * mustaches (`{expr}` between tags, not an attribute, not `{@html}`) whose
 * expression reads one of the known reply/note/message text accessors
 * (`CONTENT`). Each must be in `PLAIN`, with the reason it stays plain, or
 * the test fails — so a new surface that interpolates such text raw, or a
 * typeset surface reverted to a text node, fails the build. Its reach is the
 * accessor list: text reached through a name not in `CONTENT` is not seen.
 */
import { describe, expect, it } from "vitest";
import { quoteSummary } from "./asideQuote";
import { chipLabel } from "./passageComments";
import { heldLabel } from "./heldPassage.svelte";
import { mathParts } from "./userMath";

// Every Svelte source under src/, read at build time (no node:fs; `npm run check` rejects it).
const SOURCES = import.meta.glob("../**/*.svelte", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** Expressions that read words from a reply, a note or his message. */
const CONTENT: RegExp[] = [
  /\.said\b/,
  /\bquote\??\.text\b/,
  /\b(chipLabel|heldLabel|shownQuote|quoteSnippet|quoteSummary|asideQuoteLine|firstQuestion|firstLine)\(/,
  /\b(handoff|hand)\.text\b/,
  /\bpreview\(d\.text\)/,
  /^s\.text$/,
  /\b(g\.)?seg\.text\b/,
  /\bq\.text\b/,
];

/** `file|expression` → why that text node stays plain. */
const PLAIN: Record<string, string> = {
  "lib/Composer.svelte|chipLabel(c)": "a diff passage's chip: diff lines are code, never maths",
  "lib/Composer.svelte|shownQuote(oc)": "a diff passage in the comment box: diff lines are code, never maths",
  "lib/HandoffBubbleCard.svelte|handoff.text": "the hand-off message shown verbatim in a <pre>, as it was sent",
  "remote/Remote.svelte|hand.text": "the phone's hand-off message shown verbatim in a <pre>, as it was sent",
  "lib/UserBubble.svelte|seg.text": "a > quote line that needs no rendering (quoteNeedsRender false: no $, \\(, \\[ in it)",
  "lib/UserBubbleClassic.svelte|seg.text": "a > quote line that needs no rendering (quoteNeedsRender false: no $, \\(, \\[ in it)",
  "lib/AssistantMessage.svelte|g.seg.text": "the app's own notice (stand-in, turn notice), not the model's words",
  "lib/AssistantMessageClassic.svelte|g.seg.text": "the app's own notice (stand-in, turn notice), not the model's words",
  "lib/SubagentView.svelte|s.text": "the app's own notice in a subagent's run, not the model's words",
  "lib/ContextPanel.svelte|seg.text": "the context reader: the raw text the model is sent, verbatim by design",
  "remote/ContextSheet.svelte|seg.text": "the phone's context reader: the raw text the model is sent, verbatim by design",
};

/** The text-node mustaches of a Svelte file's markup (script and style skipped). */
function textMustaches(src: string): string[] {
  const markup = src.replace(/<script[\s\S]*?<\/script>/g, (m) => " ".repeat(m.length)).replace(/<style[\s\S]*?<\/style>/g, (m) => " ".repeat(m.length));
  const out: string[] = [];
  let i = 0;
  let inTag = false;
  while (i < markup.length) {
    const ch = markup[i];
    if (ch === "{") {
      let depth = 0;
      let j = i;
      for (; j < markup.length; j++) {
        if (markup[j] === "{") depth++;
        else if (markup[j] === "}" && --depth === 0) break;
      }
      const expr = markup.slice(i + 1, j).trim();
      if (!inTag && !/^[#/:@]/.test(expr)) out.push(expr);
      i = j + 1;
      continue;
    }
    if (!inTag && ch === "<" && /[A-Za-z!/]/.test(markup[i + 1] ?? "")) inTag = true;
    else if (inTag && ch === ">") inTag = false;
    i++;
  }
  return out;
}

describe("item 880: reply, note and message text is never drawn raw", () => {
  it("finds the Svelte sources", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100);
  });

  it("every text node reading reply/note/message words goes through the maths renderer, or is listed plain with why", () => {
    const raw: string[] = [];
    const used = new Set<string>();
    for (const [path, src] of Object.entries(SOURCES)) {
      const file = path.replace(/^\.\//, "lib/").replace(/^\.\.\//, "");
      for (const expr of textMustaches(src)) {
        if (!CONTENT.some((re) => re.test(expr))) continue;
        const k = `${file}|${expr}`;
        if (k in PLAIN) used.add(k);
        else raw.push(k);
      }
    }
    expect(raw).toEqual([]);
    // A plain entry whose text node is gone is stale: drop it.
    expect(Object.keys(PLAIN).filter((k) => !used.has(k))).toEqual([]);
  });

  it("the scanner sees a raw text node and skips attributes and {@html}", () => {
    const src = `<script>let a;</script><div title={a.said}>{@html renderReply(a.said)}<b>{a.said}</b><MathText text={a.said} /></div>`;
    expect(textMustaches(src)).toEqual(["a.said"]);
  });
});

describe("item 880: a chip keeps its formulas for MathText", () => {
  const his = "$$t_{\\text{ripple}} = N \\cdot t_{FA}$$";

  it("his passage: the comment chip and the held chip keep it as one inline formula, typeset", () => {
    expect(chipLabel({ quote: his, source: "reply" }, undefined, { math: true })).toBe("$t_{\\text{ripple}} = N \\cdot t_{FA}$");
    expect(heldLabel({ text: his, role: "assistant", ordinal: 1 }, undefined, { math: true })).toBe("$t_{\\text{ripple}} = N \\cdot t_{FA}$");
    const parts = mathParts(chipLabel({ quote: his, source: "reply" }, undefined, { math: true }));
    expect(parts).toEqual([{ kind: "math", tex: "t_{\\text{ripple}} = N \\cdot t_{FA}", display: false, src: "$t_{\\text{ripple}} = N \\cdot t_{FA}$" }]);
  });

  it("a display formula over several lines, \\[…\\] and \\(…\\) become one inline formula each", () => {
    expect(quoteSummary("Then\n$$\nx^2\n+ 1\n$$\nand \\(a\\) or \\[b\\]", 80, { math: true })).toBe("Then $x^2 + 1$ and $a$ or $b$");
  });

  it("the cut never lands inside a formula", () => {
    const t = `${"w".repeat(20)} $\\frac{a}{b} + c$ tail`;
    expect(quoteSummary(t, 25, { math: true })).toBe(`${"w".repeat(20)}…`);
    expect(quoteSummary("$\\frac{a}{b} + c$ and more words here", 5, { math: true })).toBe("$\\frac{a}{b} + c$…");
  });

  it("without math the chip words are as before (tips and dialogs): no dollar signs", () => {
    expect(chipLabel({ quote: his, source: "reply" })).toBe("t_{\\text{ripple}} = N \\cdot t_{FA}");
  });

  it("a diff passage is never read as maths", () => {
    expect(chipLabel({ quote: "--- a\n+++ a\n-$x$\n+$y$", source: "diff" }, undefined, { math: true })).toBe("-$x$ +$y$");
  });
});
