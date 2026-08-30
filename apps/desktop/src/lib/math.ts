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
const DOLLAR = /^\$([^\s$`][^\n$`]{0,158}[^\s$`]|[^\s$`])\$(?!\d)/;

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
    return `<span class="math-error" title="${escapeAttr(why)}">${escapeText(tex)}</span>`;
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
