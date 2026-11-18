import katex from "katex";
import type { MarkedExtension, TokenizerAndRendererExtension } from "marked";

/**
 * TeX in assistant text, rendered by KaTeX.
 *
 * Models write math in four spellings and there is no negotiating which:
 * `$$…$$` and `\[…\]` for display, `$…$` and `\(…\)` inline. All four are
 * taken, plus a ```math fence. Recognition has to happen in marked's
 * *tokenizer* rather than as a pass over the rendered HTML, because by the
 * time markdown has been parsed `$a_i$` is an italic run and `$x*y*z$` is an
 * emphasis — the delimiters survive but the formula between them does not.
 *
 * An unterminated formula is left as literal text, which is also what makes
 * this safe to run on a half-streamed reply: `$$\int` renders as those five
 * characters until the closing delimiter arrives.
 */

/** Delimiter pairs recognized in running text, longest opener first. */
const PAIRS: { open: string; close: string; display: boolean }[] = [
  { open: "$$", close: "$$", display: true },
  { open: "\\[", close: "\\]", display: true },
  { open: "\\(", close: "\\)", display: false },
];

/**
 * A `$…$` span. This is the one delimiter that also means money, so it comes
 * with guards, each of which earns its place against a sentence seen in real
 * output:
 *
 *   no space just inside either delimiter — "between $5 and $10"
 *   no digit just past the closing one   — "$100$200"
 *   one line only                        — "$1,200 total.\nCode stays code:"
 *   no backtick inside                   — "…or $5. Use `$PATH`"
 *   and a length cap, because every one of those failures is a long span
 *
 * The first two are GitHub's rule and catch most of it; the rest are what a
 * chat reply adds on top, where prose and code sit in the same paragraph as
 * the maths. Note that none of this can lean on markdown's own code spans:
 * an extension tokenizer runs *before* those exist, which is exactly why a
 * `$` two lines down could reach into one.
 */
// An escaped dollar (`\$`) is part of the formula, not a delimiter: a model
// writes a negative amount as `$-\$0.05$` (item 442), and without escape pairs
// that span fell back to raw text.
const DOLLAR = /^\$((?:\\[^\n]|[^\s$`\\])(?:(?:\\[^\n]|[^\n$`\\]){0,158}(?:\\[^\n]|[^\s$`\\]))?)\$(?!\d)/;

/** Where the next thing that could open a formula starts. */
const OPENER = /\$|\\[[(]/;

interface Hit {
  raw: string;
  tex: string;
  display: boolean;
}

function matchInline(src: string): Hit | null {
  for (const p of PAIRS) {
    if (!src.startsWith(p.open)) continue;
    const end = src.indexOf(p.close, p.open.length);
    if (end < 0) continue;
    const tex = src.slice(p.open.length, end);
    if (!tex.trim()) continue;
    return { raw: src.slice(0, end + p.close.length), tex, display: p.display };
  }
  const m = DOLLAR.exec(src);
  return m ? { raw: m[0], tex: m[1], display: false } : null;
}

/**
 * A display formula standing alone as its own block. The inline rule would
 * catch most of these anyway, since a `$$…$$` paragraph reaches it whole —
 * but not one containing a blank line, which markdown has already split into
 * two paragraphs by then. `\begin{aligned}` blocks are written that way.
 */
const BLOCK = /^ {0,3}(\$\$|\\\[)([\s\S]*?)(\$\$|\\\])[ \t]*(?:\n+|$)/;
const BLOCK_START = /(^|\n) {0,3}(\$\$|\\\[)/;

/** Render one formula, or say so in place if KaTeX cannot. */
export function renderMath(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, {
      displayMode: display,
      // A malformed formula is shown in red where it stands, with KaTeX's
      // complaint as its tooltip. Throwing would cost the whole message.
      throwOnError: false,
      // KaTeX writes this straight into a style attribute, so it can be the
      // theme's own variable rather than a second copy of the hex — its
      // default #cc0000 is nearly invisible on this background.
      errorColor: "var(--error)",
      // "warn" narrates every unicode character and `\newline` to the
      // console; nothing here reads that, and a chat reply is full of both.
      strict: "ignore",
      output: "htmlAndMathml",
    });
  } catch (err) {
    // Reached only for the errors KaTeX raises regardless of throwOnError
    // (macro expansion blowing its budget, mostly).
    const why = err instanceof Error ? err.message : String(err);
    return `<span class="math-error" data-tip="${escapeAttr(why)}">${escapeText(tex)}</span>`;
  }
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;");
}

const blockMath: TokenizerAndRendererExtension = {
  name: "mathBlock",
  level: "block",
  start(src: string) {
    const i = src.search(BLOCK_START);
    return i < 0 ? undefined : i;
  },
  tokenizer(src: string) {
    const m = BLOCK.exec(src);
    if (!m) return undefined;
    const closes = m[1] === "$$" ? "$$" : "\\]";
    if (m[3] !== closes || !m[2].trim()) return undefined;
    return { type: "mathBlock", raw: m[0], tex: m[2], display: true };
  },
  renderer(token) {
    return renderMath(token.tex as string, true);
  },
};

const inlineMath: TokenizerAndRendererExtension = {
  name: "mathInline",
  level: "inline",
  start(src: string) {
    const i = src.search(OPENER);
    return i < 0 ? undefined : i;
  },
  tokenizer(src: string) {
    const hit = matchInline(src);
    if (!hit) return undefined;
    return { type: "mathInline", raw: hit.raw, tex: hit.tex, display: hit.display };
  },
  renderer(token) {
    return renderMath(token.tex as string, token.display as boolean);
  },
};

/**
 * A formula found in a note's source, for the formatted editor (nightshift
 * backlog 150): `from`/`to` are offsets into the text, delimiters included,
 * and `openLen` is the opening delimiter's length, so a click on the
 * rendered formula can put the cursor just inside it. `block` is a display
 * formula standing on its own lines, which the editor draws as a block.
 */
export interface MathSpan {
  from: number;
  to: number;
  tex: string;
  display: boolean;
  block: boolean;
  openLen: number;
}

/** Where the paragraph holding `i` ends: the next blank line, or the end. */
function paragraphEnd(src: string, i: number): number {
  const blank = /\n[ \t]*\n/g;
  blank.lastIndex = i;
  const m = blank.exec(src);
  return m ? m.index : src.length;
}

/**
 * Every formula in `src`, in order, by the same rules the preview renders
 * with — `BLOCK` at the start of a line, `matchInline` anywhere else, both
 * bounded by the paragraph as marked's inline pass is, and a backslash
 * escaping the character after it (`\$5`). Code is not excluded here: the
 * editor knows where code is from its own parse and drops spans inside it.
 */
export function findMath(src: string): MathSpan[] {
  const out: MathSpan[] = [];
  let i = 0;
  while (i < src.length) {
    if (i === 0 || src.charCodeAt(i - 1) === 10) {
      const m = BLOCK.exec(src.slice(i));
      if (m) {
        const closes = m[1] === "$$" ? "$$" : "\\]";
        if (m[3] === closes && m[2].trim()) {
          const from = i + m[0].indexOf(m[1]);
          const to = from + m[1].length + m[2].length + m[3].length;
          out.push({ from, to, tex: m[2], display: true, block: true, openLen: m[1].length });
          i = to;
          continue;
        }
      }
    }
    const ch = src[i];
    if (ch === "\\" && src[i + 1] !== "(" && src[i + 1] !== "[") {
      i += 2;
      continue;
    }
    if (ch === "$" || ch === "\\") {
      const hit = matchInline(src.slice(i, paragraphEnd(src, i)));
      if (hit) {
        const openLen = hit.raw.startsWith("$$") || hit.raw.startsWith("\\") ? 2 : 1;
        out.push({ from: i, to: i + hit.raw.length, tex: hit.tex, display: hit.display, block: false, openLen });
        i += hit.raw.length;
        continue;
      }
    }
    i++;
  }
  return out;
}

/**
 * Item 837: the `$…$` rule for text a person typed (the message box, his
 * sent message, the phone's copy of it) over the replies' guards above: a
 * one-dollar span whose closing `$` runs straight into a word, or whose
 * opening one follows a word, is shell, not maths — `$HOME/bin:$PATH`,
 * `echo $USER$HOST`, `a$b$c`. (The box's rule since item 276, moved here
 * so the bubble reads his words exactly as the box drew them.)
 */
const WORD_CHAR = /[A-Za-z0-9_]/;
export function typedMathOk(text: string, m: MathSpan): boolean {
  if (m.display || m.openLen !== 1) return true;
  const before = m.from > 0 ? text[m.from - 1] : "";
  const after = m.to < text.length ? text[m.to] : "";
  // A `$` touching another `$` is part of a `$$` run, never a one-dollar
  // delimiter: `$$abc$` is a display formula half typed, not a `$` and
  // then `$abc$` (his first bug, 2026-10-01), and `$a$$` is not `$a$`.
  if (before === "$" || after === "$") return false;
  return !WORD_CHAR.test(before) && !WORD_CHAR.test(after);
}

/** Is the formula `[from, to)` alone on its line(s) — nothing but space
 *  before it on its first line or after it on its last? A display formula
 *  among words is set in text style everywhere his words are drawn (a
 *  block would split the sentence it stands in). */
export function aloneOnLines(text: string, from: number, to: number): boolean {
  const a = text.lastIndexOf("\n", from - 1) + 1;
  let b = text.indexOf("\n", to);
  if (b < 0) b = text.length;
  return text.slice(a, from).trim() === "" && text.slice(to, b).trim() === "";
}

/**
 * Item 837 (his 836: a streaming table cell showed `$\frac{x-1}{\`): where
 * a formula that has opened but not closed yet starts in a half-streamed
 * reply, or -1. `streamingTail` holds the reply back to there, so a formula
 * appears whole when its closing delimiter arrives and is never shown as
 * raw half-commands. The scan is `findMath`'s, skipping code (fences and
 * `spans`); what it adds is the openers `findMath` leaves as text:
 *
 *   `$$` or `\[` at a line start with no closer after it (a display block
 *     may hold blank lines, so anywhere later counts);
 *   `$$`, `\(`, `\[` in the last paragraph with no closer;
 *   a single `$` on the last line that can still become a formula — not a
 *     price (`$5`), not a shell variable (`$HOME`), and either carrying a
 *     TeX mark (`\`, `^`, `_`, `{`) or still short, so "costs $x" is held
 *     for a few characters and prose after a stray `$` is not held for long;
 *   a lone `\` or `$` as the very last character (half a delimiter).
 */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const HOLD_PLAIN_CHARS = 24;
export function openMathAt(src: string): number {
  const n = src.length;
  let i = 0;
  while (i < n) {
    const lineStart = i === 0 || src.charCodeAt(i - 1) === 10;
    if (lineStart) {
      const rest = src.slice(i);
      const f = FENCE_OPEN.exec(rest);
      if (f) {
        // A fenced block: to the line after its closing fence, or the end.
        const close = new RegExp(`\\n {0,3}${f[1][0]}{${f[1].length},}[ \\t]*(?=\\n|$)`).exec(rest);
        if (!close) return -1;
        i += close.index + close[0].length;
        continue;
      }
      const m = BLOCK.exec(rest);
      if (m) {
        const closes = m[1] === "$$" ? "$$" : "\\]";
        if (m[3] === closes && m[2].trim()) {
          i += m[0].length;
          continue;
        }
      }
      const o = /^ {0,3}(\$\$|\\\[)/.exec(rest);
      if (o) {
        const at = i + o[0].length - o[1].length;
        const closer = o[1] === "$$" ? "$$" : "\\]";
        if (src.indexOf(closer, at + 2) < 0) return at;
      }
    }
    const ch = src[i];
    if (ch === "`") {
      // A code span: to its closing run in this paragraph (none: the tick is text).
      let k = i;
      while (src[k] === "`") k++;
      const ticks = src.slice(i, k);
      const end = src.indexOf(ticks, k);
      i = end >= 0 && end < paragraphEnd(src, i) ? end + ticks.length : k;
      continue;
    }
    if (ch === "\\" && src[i + 1] !== "(" && src[i + 1] !== "[") {
      if (i === n - 1) return i;
      i += 2;
      continue;
    }
    if (ch === "$" || ch === "\\") {
      const pEnd = paragraphEnd(src, i);
      const hit = matchInline(src.slice(i, pEnd));
      if (hit) {
        i += hit.raw.length;
        continue;
      }
      const two = src.slice(i, i + 2);
      if (two === "$$" || two === "\\(" || two === "\\[") {
        if (pEnd === n) return i;
        i += 2;
        continue;
      }
      // A single `$`: only on the last line can it still close.
      if (src.indexOf("\n", i) < 0) {
        const tail = src.slice(i + 1);
        if (tail === "") return i;
        const price = /^[\d\s]/.test(tail);
        const shell = /^[A-Z_][A-Z0-9_]+\b/.test(tail);
        const tex = /[\\^_{]/.test(tail);
        if (!price && !shell && !tail.includes("`") && tail.length <= 160 && (tex || tail.length <= HOLD_PLAIN_CHARS)) return i;
      }
    }
    i++;
  }
  return -1;
}

/** The marked extension: `marked.use(math)`. */
export const math: MarkedExtension = {
  extensions: [blockMath, inlineMath],
  renderer: {
    // ```math is the fenced spelling GitHub renders; anything else stays a
    // code sample, `latex` very much included — a fenced LaTeX listing is
    // usually source the reader wants to see rather than typeset.
    code({ text, lang }) {
      return lang === "math" ? renderMath(text, true) : false;
    },
  },
};
