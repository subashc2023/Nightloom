// Item 626 — a streaming reply must read right while it streams. His report: text "formatted off … spacing errors …
// tokens slightly moved in different orders … the second the turn ends … the formatting fixes". This replays a realistic
// stream (paragraphs, bold, inline code, a link, lists, a table, a code fence; deltas of 1–40 characters) through the
// real renderer and the motion's arrival log, and checks at every delta that what is visible is a prefix-consistent
// rendering: the words the motion still hides are the newest ones (none behind a shown word), every animating span covers
// one word's own characters, and the visible words lead into the settled reply's words. The DOM side (inline spans, no
// mid-word wraps) is measured in WebKit: notes/runner-design/626-report-2026-11-11.md.
import { describe, expect, it, vi } from "vitest";
// The suite runs in node, where DOMPurify has no window; its pass changes no text of this reply.
vi.mock("dompurify", () => ({ default: { sanitize: (h: string) => h } }));
import { renderReply, streamingTail } from "./markdown";
import { align, arrive, BURST_WORDS, type Track } from "./replyMotion";

const REPLY = `I checked the run from last night, and **the short version** is that the cut data held up: every tier scored within the band we set, and the two outliers trace back to one flaky fixture rather than the model.

## What the run showed

- **Tier 1** (the 40 smallest repos): 38 of 40 passed, and both failures were the same \`test_signup_redirect\` timing out on a cold cache.
- **Tier 2**: 112 of 118, with the six misses spread across three repos — none of them new since the [last report](https://example.com/report/41).
- **Tier 3** is still running; the first 20 results look like Tier 2's.

The scores diverge where you would expect: the differential tests and the developer suite agree on *every* patch we sampled, except where a patch touched the session middleware.

| Tier | Passed | Failed | Median time |
|------|--------|--------|-------------|
| 1 | 38 | 2 | 4.1 s |
| 2 | 112 | 6 | 7.8 s |
| 3 | 20 | 0 | 9.2 s |

To reproduce the one failure locally:

\`\`\`bash
cd repos/signup-flow
CACHE=cold pytest tests/test_signup.py -k redirect --count 20
\`\`\`

1. Run it with a cold cache first, so the timeout shows.
2. Then warm the cache with \`make warm\` and run it again; it should pass.
3. If it still fails, the fixture is not the cause and we look at the middleware.

So my read is that nothing in the cut data is wrong. The next step is the smaller tiers, which I can start now if you want — they take about **twenty minutes** and need no new setup.`;

/** The stream: the harness's chunking (seeded), 1–40 characters, ~38 ms apart, one burst of 24 in the same millisecond. */
function stream(seed: number): { at: number; text: string }[] {
  let s = seed >>> 0;
  const r = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const out: { at: number; text: string }[] = [];
  let i = 0;
  let t = 0;
  let k = 0;
  while (i < REPLY.length) {
    const u = r();
    const n = u < 0.08 ? 1 + Math.floor(r() * 2) : u < 0.9 ? 3 + Math.floor(r() * 12) : 15 + Math.floor(r() * 26);
    out.push({ at: (t += ++k === 60 ? 900 : k > 60 && k <= 84 ? 0 : 20 + Math.floor(r() * 36)), text: REPLY.slice(i, i + n) });
    i += n;
  }
  return out;
}

/** A block's textContent, without a DOM: the HTML's text nodes in order. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
const words = (s: string) => s.replace(/[*_`#|>[\]()~\\-]/g, " ").split(/\s+/).filter(Boolean);

/** His second report: after a long thinking block the text lands in one burst — the first 2,400 characters in one delta. */
function burstStream(seed: number) {
  const d = stream(seed);
  let n = 0;
  let k = 0;
  while (k < d.length && n < 2400) n += d[k++].text.length;
  return [{ at: d[0].at, text: d.slice(0, k).map((x) => x.text).join("") }, ...d.slice(k)];
}

function replay(seed: number, burst = false) {
  const s: Track = { len: 0, live: [] };
  const finalWords = words(textOf(renderReply(REPLY)));
  const bad = { order: 0, span: 0, prefix: 0, examples: [] as string[] };
  let src = "";
  let maxLive = 0;
  for (const d of burst ? burstStream(seed) : stream(seed)) {
    src += d.text;
    // As AssistantMessage draws it while streaming.
    const text = textOf(renderReply(streamingTail(src)));
    const t = d.at;
    arrive(s, text, t);
    maxLive = Math.max(maxLive, s.live.length);
    const hidden = new Uint8Array(text.length);
    for (const r of s.live) {
      // Each animating span covers one word's own characters.
      if (/\s/.test(text.slice(r.from, r.to)) || r.to > text.trimEnd().length) {
        bad.span++;
        if (bad.examples.length < 3) bad.examples.push(`span "${text.slice(r.from, r.to)}" at ${src.length}`);
      }
      if (r.start > t) for (let k = r.from; k < r.to; k++) hidden[k] = 1;
    }
    // What the motion still hides is the newest text: no shown word after a hidden one.
    let sawHidden = false;
    let order = false;
    for (let k = 0; k < text.length; k++) {
      if (hidden[k]) sawHidden = true;
      else if (sawHidden && /\S/.test(text[k])) order = true;
    }
    if (order) bad.order++;
    // The visible words lead into the settled reply's (markdown punctuation aside; the last may be half a word).
    const vis = words(Array.from(text, (c, k) => (hidden[k] ? "" : c)).join(""));
    const ok = vis.every((w, k) => w === finalWords[k] || (k === vis.length - 1 && finalWords[k]?.startsWith(w)));
    if (!ok) {
      bad.prefix++;
      if (bad.examples.length < 3) {
        const j = vis.findIndex((w, k) => w !== finalWords[k]);
        bad.examples.push(`at ${src.length}: "${vis.slice(j - 2, j + 3).join(" ")}" vs "${finalWords.slice(j - 2, j + 3).join(" ")}"`);
      }
    }
  }
  return { ...bad, maxLive };
}

describe("item 626 — a streaming reply is prefix-consistent at every delta", () => {
  it.each([626, 1, 2, 3, 4])("seed %i: no hidden word behind a shown one, no span off its word, the words lead to the settled reply", (seed) => {
    const bad = replay(seed);
    expect(bad, bad.examples.join("\n")).toMatchObject({ order: 0, span: 0, prefix: 0 });
  });

  it.each([626, 1, 2])("seed %i, the text in one 2,400-character burst after thinking: prefix-consistent, and only the burst's tail animates", (seed) => {
    const bad = replay(seed, true);
    expect(bad, bad.examples.join("\n")).toMatchObject({ order: 0, span: 0, prefix: 0 });
    // Before: every word of the burst (~400) was wrapped in its own blurred, rising span at once.
    expect(bad.maxLive).toBeLessThanOrEqual(BURST_WORDS * 3);
  });

  it("closing markup that rewrites shown text keeps each animating word on its own characters", () => {
    const s: Track = { len: 0, live: [] };
    arrive(s, "Hello **wor", 0);
    // "**wor" closes into "world": the live word now covers "wor" in "world", the new "ld and" arrives after it.
    arrive(s, "Hello world and", 40);
    const shown = s.live.map((r) => "Hello world and".slice(r.from, r.to));
    expect(shown).toEqual(["Hello", "wor", "ld", "and"]);
    expect(s.live.find((r) => r.from === 6)!.start).toBe(s.live.find((r) => r.from === 9)!.start);
  });

  it("align maps deletions and table newlines", () => {
    const { at, end } = align("| a | b", "\n\n\na\nb", 0);
    expect(at[2]).toBe(3);
    expect(at[6]).toBe(5);
    expect(end).toBe(6);
  });

  it("streamingTail: the unfinished tail renders as it will once finished", () => {
    expect(streamingTail("and **the short ver")).toBe("and **the short ver**");
    expect(streamingTail("and **")).toBe("and ");
    expect(streamingTail("the same `test_sign")).toBe("the same `test_sign`");
    expect(streamingTail("**Tier 1** and `x` then **bo")).toBe("**Tier 1** and `x` then **bo**");
    expect(streamingTail("since the [last report](https://exa")).toBe("since the last report");
    expect(streamingTail("text\n\n| Tier | Passed |\n|---")).toBe("text\n");
    expect(streamingTail("| a | b |\n|---|---|\n| 1 | 2")).toBe("| a | b |\n|---|---|\n| 1 | 2");
    expect(streamingTail("```bash\ncd **x")).toBe("```bash\ncd **x");
    expect(streamingTail("Done. **All** of it.")).toBe("Done. **All** of it.");
  });
});
