/**
 * Item 837 (his 831: "latex not formatting in my messages"): the maths in
 * words a person typed, for every place those words are drawn after they
 * are sent — his bubble in both looks (and so the queued, scheduled and
 * aside bubbles, which are the same piece), and the phone's copy of it.
 * Before, his words were a text node and nothing in them was ever typeset.
 *
 * One reading, the box's: the delimiters and guards are `math.ts`'s
 * (`findMath`: `$…$`, `$$…$$`, `\(…\)`, `\[…\]`), with the typed-text shell
 * guard the message box has always applied (`typedMathOk`: `$HOME/bin:$PATH`
 * is not a formula), never inside a `code span`. A display formula alone on
 * its line(s) is a block; among words it is set in text style, as the box
 * draws it. Then the runs of bare LaTeX the box offers to wrap
 * (`bareLatex.ts`, item 479 — a known command or a `^{…}` group, KaTeX must
 * render it, never in code, quotes, URLs or paths): what the box calls
 * "clearly LaTeX" reads as maths once sent, wrapped or not, so two lines of
 * the same message no longer come out one typeset and one raw (his 834).
 *
 * The text is never changed: the parts' `text` and `src`, joined, are it.
 */
import { aloneOnLines, findMath, typedMathOk } from "./math";
import { findBareLatex } from "./bareLatex";
import { protectedRanges } from "./typedMath";

export type MathPart =
  | { kind: "text"; text: string }
  /** `src` is the span as typed, delimiters included; `block`: a display
   *  formula on lines of its own (the line breaks round it are its margin). */
  | { kind: "math"; tex: string; display: boolean; src: string };

const memo = new Map<string, MathPart[]>();

export function mathParts(text: string): MathPart[] {
  if (!/[$\\]|[_^]\{/.test(text)) return [{ kind: "text", text }];
  const hit = memo.get(text);
  if (hit) return hit;
  const parts = mathPartsUncached(text);
  if (memo.size >= 200) memo.delete(memo.keys().next().value!);
  memo.set(text, parts);
  return parts;
}

/** In a bare-LaTeX run of his (no delimiters), a function
 *  name before its argument is set upright as the box would (`ln(` → `\ln(`);
 *  KaTeX would draw `ln` as the product l·n. The drawn TeX only; his text is kept. */
function uprightFunctions(tex: string): string {
  return tex.replace(/(?<![\\A-Za-z])(ln|log|exp|sin|cos|tan)(?=\s*[({\\])/g, "\\$1");
}

function mathPartsUncached(text: string): MathPart[] {
  const code: [number, number][] = [];
  for (const m of text.matchAll(/`[^`\n]*`/g)) code.push([m.index, m.index + m[0].length]);
  const inCode = (a: number, b: number) => code.some(([x, y]) => a < y && b > x);
  const spans: { from: number; to: number; tex: string; display: boolean }[] = [];
  for (const m of findMath(text)) {
    if (inCode(m.from, m.to) || !typedMathOk(text, m)) continue;
    spans.push({ from: m.from, to: m.to, tex: m.tex, display: m.display && aloneOnLines(text, m.from, m.to) });
  }
  const taken = (a: number, b: number) => spans.some((s) => a < s.to && b > s.from);
  const bare = findBareLatex(text, protectedRanges(text)).filter((b) => !taken(b.from, b.to));
  for (const b of bare) spans.push({ from: b.from, to: b.to, tex: uprightFunctions(b.src), display: b.display });
  if (spans.length === 0) return [{ kind: "text", text }];
  spans.sort((a, b) => a.from - b.from);
  const out: MathPart[] = [];
  let at = 0;
  for (const s of spans) {
    if (s.from < at) continue;
    if (s.from > at) out.push({ kind: "text", text: text.slice(at, s.from) });
    out.push({ kind: "math", tex: s.tex, display: s.display, src: text.slice(s.from, s.to) });
    at = s.to;
  }
  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });
  return out;
}

/** The parts as drawn: a block formula has its own margins, so the one line
 *  break on each side of it is not drawn as well (the text is `pre-wrap`). */
export function drawnParts(parts: MathPart[]): MathPart[] {
  return parts.map((p, i) => {
    if (p.kind !== "text") return p;
    let t = p.text;
    const prev = parts[i - 1];
    const next = parts[i + 1];
    if (prev?.kind === "math" && prev.display && t.startsWith("\n")) t = t.slice(1);
    if (next?.kind === "math" && next.display && t.endsWith("\n")) t = t.slice(0, -1);
    return t === p.text ? p : { kind: "text", text: t };
  });
}
