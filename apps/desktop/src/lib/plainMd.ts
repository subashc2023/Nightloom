import { plainPreview } from "../remote/preview";

/**
 * Item 999 (the 991 family, second pass; the verify sweep's finding 6): text built from a message or a
 * reply for a one-line place — a search snippet, a navigator rib's bubble and its accessible name, an
 * aside's label, a chat's name — showed the reply's Markdown marks raw ("…the **sampling…", "Go to the
 * reply: You picked **Blue**"). These drop the marks and keep the words.
 *
 * - `plainOneLine`: a whole message on one line (the phone menu's `plainPreview`, whitespace collapsed,
 *   the chat's own tags — `<ask>`, `<handoff>` — dropped).
 * - `plainFragment`: a piece of a message cut anywhere — a search snippet's text before or after its hit —
 *   so a pair of marks can be split across pieces (`**` before the hit, `**` after it). Every bold, strike
 *   and code mark goes; a single `*` or `_` only where it opens or closes a word (so `x_bar`, `2 * 3` stay);
 *   leading and trailing spaces are kept, since the pieces are drawn joined.
 */

const TAG = /<\/?(?:ask|handoff)\b[^>]*>/gi;

/** The message's words with its marks dropped, lines kept (a code fence keeps its code). */
export function plainLines(md: string): string {
  return plainPreview(md.replace(TAG, "\n"));
}

export function plainOneLine(md: string): string {
  return plainMath(plainLines(md)).replace(/\s+/g, " ").trim();
}

/*
 * Item 1014 (740 audit): search snippets showed raw LaTeX — `$\bar x$`, `$np \ge 10$`. A one-line place
 * cannot typeset, so the math is spelled in plain characters: the delimiters go, `\ge` is ≥, `\bar x` is x̄,
 * `\frac{a}{b}` is a/b, a Greek name its letter, any other command its name. A snippet is cut anywhere, so a
 * lone `$` goes where it opens (`$x`) or closes (`x$`) math; a price (`$5`) stays.
 */
const MATH_SYM: Record<string, string> = {
  ge: "≥", geq: "≥", le: "≤", leq: "≤", ne: "≠", neq: "≠", approx: "≈", equiv: "≡", sim: "~", propto: "∝",
  times: "×", cdot: "·", div: "÷", pm: "±", mp: "∓", to: "→", rightarrow: "→", Rightarrow: "⇒", leftarrow: "←",
  infty: "∞", sum: "Σ", prod: "Π", int: "∫", partial: "∂", nabla: "∇", in: "∈", notin: "∉", subset: "⊂",
  subseteq: "⊆", cup: "∪", cap: "∩", emptyset: "∅", forall: "∀", exists: "∃", neg: "¬", land: "∧", lor: "∨",
  ldots: "…", dots: "…", cdots: "⋯", mid: "|", lvert: "|", rvert: "|", vert: "|", prime: "′", circ: "∘", deg: "°",
  alpha: "α", beta: "β", gamma: "γ", Gamma: "Γ", delta: "δ", Delta: "Δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ",
  eta: "η", theta: "θ", Theta: "Θ", iota: "ι", kappa: "κ", lambda: "λ", Lambda: "Λ", mu: "μ", nu: "ν", xi: "ξ",
  pi: "π", Pi: "Π", rho: "ρ", sigma: "σ", Sigma: "Σ", tau: "τ", phi: "φ", varphi: "φ", Phi: "Φ", chi: "χ",
  psi: "ψ", Psi: "Ψ", omega: "ω", Omega: "Ω", quad: " ", qquad: " ",
};
const MATH_ACCENT: Record<string, string> = { bar: "\u0304", overline: "\u0304", hat: "\u0302", widehat: "\u0302", tilde: "\u0303", widetilde: "\u0303", vec: "\u20d7", dot: "\u0307", ddot: "\u0308" };
const GROUP = String.raw`\{([^{}]*)\}`;

export function plainMath(s: string, force = false): string {
  if (!s || !/[\\$]/.test(s)) return s;
  // Only text that is math: a command beside a `$` or `\(`/`\[` delimiter. Without a command, only a tight
  // `$x$` pair loses its dollars — so a path (`C:\Users`), a template (`${x}`) or a price is left alone.
  if (!force && !(/\\[A-Za-z]+/.test(s) && /\$|\\[([]/.test(s))) return s.replace(/\$([^\s$\d{}][^$]*?[^\s$\\{}]|[^\s$\d{}])\$/g, "$1");
  const atom = (x: string) => (x.length <= 1 || /^[\\√]?[\w.]+$/.test(x) ? x : `(${x})`);
  return (
    s
      .replace(/\\\$/g, "\u0002")
      .replace(/\$\$/g, "")
      .replace(/\\[()[\]]/g, "")
      .replace(new RegExp(String.raw`\\sqrt\s*${GROUP}`, "g"), (_, a: string) => `√${atom(a)}`)
      .replace(/\\sqrt\s*(\w)/g, "√$1")
      .replace(new RegExp(String.raw`\\(${Object.keys(MATH_ACCENT).join("|")})\s*(?:${GROUP}|([A-Za-z0-9]))`, "g"), (_, k: string, g?: string, c?: string) => {
        const body = g ?? c ?? "";
        return body ? body[0] + MATH_ACCENT[k] + body.slice(1) : "";
      })
      .replace(new RegExp(String.raw`\\(?:text|mathrm|mathbf|mathit|mathsf|mathtt|mathbb|mathcal|operatorname|textbf|textit|boldsymbol)\s*${GROUP}`, "g"), "$1")
      .replace(new RegExp(String.raw`\\[dt]?frac\s*${GROUP}\s*${GROUP}`, "g"), (_, a: string, b: string) => `${atom(a)}/${atom(b)}`)
      .replace(new RegExp(String.raw`\\[dt]?frac\s*${GROUP}\s*${GROUP}`, "g"), (_, a: string, b: string) => `${atom(a)}/${atom(b)}`)
      .replace(/\\(?:left|right|big|Big|bigg|Bigg)\b\s*/g, "")
      .replace(/\\[,;:!> ]/g, " ")
      .replace(/\\\\/g, " ")
      .replace(/\\([A-Za-z]+)/g, (_, n: string) => MATH_SYM[n] ?? n)
      .replace(/([\^_])\{([^{}]*)\}/g, "$1$2")
      .replace(/[{}]/g, "")
      // A lone `$`: opening math (`$x`, `$\`), closing it (`x$`), or a cut-off end at the piece's start.
      .replace(/\$(?=[A-Za-z\u0370-\u03ff(\[|√≥≤])/g, "")
      .replace(/(\S)\$(?=$|[\s.,;:!?)\]])/g, "$1")
      .replace(/^\$(?=$|[\s.,;:!?)\]])/, "")
      .replace(/\u0002/g, "$")
  );
}

export function plainFragment(s: string, math = false): string {
  if (!s) return s;
  const lead = /^\s*/.exec(s)?.[0] ?? "";
  const trail = lead.length === s.length ? "" : (/\s*$/.exec(s)?.[0] ?? "");
  const body = s
    .slice(lead.length, s.length - trail.length)
    .replace(TAG, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\]\([^)\s]*\)?/g, "")
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    // A dunder name (`__init__.py`) is a word, not bold; any other `__` is a mark.
    .replace(/__(\w+?)__(?=[.\w])/g, "\u0001$1\u0001")
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/\u0001/g, "__")
    .replace(/(^|[\s([{"'“‘…])[*_](?=[^\s*_])/g, "$1")
    .replace(/([^\s*_])[*_](?=$|[\s.,;:!?)\]}"'”’…])/g, "$1")
    .replace(/[ \t]{2,}/g, " ");
  return lead + plainMath(body, math) + trail;
}

/**
 * Item 1014: a search hit's three pieces, plain. The hit can fall inside math (`$\bar X$` searched for "bar x"
 * comes back as `…like $\` + `bar X` + `$. Once…`), where no piece alone holds the command; so the math span
 * around the hit — from the `$` that opens it to the one that closes it, or a command cut off at the hit — moves
 * into the hit, which is then spelled plain (`X̄`, marked) and the pieces either side lose their dollars.
 */
export function plainHit(before: string, matched: string, after: string): { before: string; matched: string; after: string } {
  let b = before;
  let m = matched;
  let a = after;
  let math = false;
  const dollars = (b.replace(/\\\$/g, "").match(/\$/g) ?? []).length;
  const close = a.replace(/\\\$/g, "\u0002\u0002").indexOf("$");
  if (dollars % 2 === 1 && close >= 0) {
    const open = b.lastIndexOf("$");
    m = b.slice(open) + m + a.slice(0, close + 1);
    b = b.slice(0, open);
    a = a.slice(close + 1);
    math = true;
  } else {
    // A command cut at the hit (`σ_\` + `bar x`): its backslash and letters go with the hit.
    const cut = /\\[A-Za-z]*$/.exec(b);
    if (cut) {
      m = cut[0] + m;
      b = b.slice(0, cut.index);
      math = true;
    }
  }
  // Beside a hit in math, the pieces are math too (`=\frac{0.4}{\sqrt{25}}` after `\bar x`).
  return { before: plainFragment(b, math), matched: math ? plainMath(m, true) : m, after: plainFragment(a, math) };
}
