/**
 * Item 348: math copied from a web page, pasted as the LaTeX it came from.
 *
 * KaTeX (the math renderer on katex.org, ChatGPT and most docs sites) draws
 * every formula twice — a hidden MathML copy for screen readers and a visible
 * one built from dozens of spans — and the clipboard's `text/plain` flattens
 * both into letters: `0xAC` arrives as "0x A C AC" (his report, 2026-10-12).
 * MathJax v3 (the other common renderer) draws glyphs with CSS, so its plain
 * text is the assistive MathML's letters or nothing. The clipboard's
 * `text/html` still holds the original: KaTeX keeps the TeX source in an
 * `<annotation encoding="application/x-tex">`, Wikipedia in `alttext`, and
 * MathJax keeps MathML, which is converted here for the common elements.
 *
 * `mathPasteText(html)` returns the paste as text with each formula as
 * `$…$` (`$$…$$` on its own lines for display math) — the delimiters the
 * composer and the replies render (`math.ts`, `composerEditor.ts`) — or
 * null when the HTML holds no math, so every other paste is left alone.
 *
 * The tests run in node with no DOM, so the HTML is read by the small tree
 * builder below rather than `DOMParser`; clipboard HTML is a browser's own
 * serialisation of a selection, well-formed enough for it.
 */

// ---- a small HTML tree ------------------------------------------------------

interface El {
  tag: string;
  attrs: Record<string, string>;
  children: Child[];
  parent: El | null;
}
type Child = El | string;

const VOID = new Set(["br", "img", "meta", "link", "hr", "input", "col", "area", "base", "wbr", "source", "embed", "param", "track"]);
const RAW = new Set(["script", "style", "textarea", "title"]);

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  minus: "−", times: "×", middot: "·", divide: "÷",
  le: "≤", ge: "≥", ne: "≠", plusmn: "±", infin: "∞",
  hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘",
  rdquo: "”", ldquo: "“", InvisibleTimes: "⁢", ApplyFunction: "⁡",
  af: "⁡", it: "⁢", sum: "∑", int: "∫", rarr: "→",
};

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) attrs[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? "");
  return attrs;
}

/** The HTML as a tree under a synthetic root. */
export function parseHtml(html: string): El {
  const root: El = { tag: "#root", attrs: {}, children: [], parent: null };
  let cur = root;
  // A tag's unquoted part stops at the next `<` (review 2026-10-12): an
  // unclosed `<a b…` no longer scans to the end of the paste at every `<`.
  const re = /<!--[\s\S]*?-->|<![^>]*>|<\?[^>]*>|<\/([a-zA-Z][^\s>/]*)\s*>|<([a-zA-Z][^\s>/]*)((?:"[^"]*"|'[^']*'|[^'"<>])*)>/g;
  const lower = html.toLowerCase(); // once, not per `<script>` (review 2026-10-12)
  let at = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m.index > at) cur.children.push(decode(html.slice(at, m.index)));
    at = re.lastIndex;
    if (m[1]) {
      const tag = m[1].toLowerCase();
      for (let e: El | null = cur; e && e !== root; e = e.parent) {
        if (e.tag === tag) {
          cur = e.parent ?? root;
          break;
        }
      }
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      const rest = m[3] ?? "";
      const el: El = { tag, attrs: parseAttrs(rest.replace(/\/\s*$/, "")), children: [], parent: cur };
      cur.children.push(el);
      if (VOID.has(tag) || /\/\s*$/.test(rest)) continue;
      if (RAW.has(tag)) {
        const end = lower.indexOf(`</${tag}`, at);
        const stop = end < 0 ? html.length : end;
        el.children.push(html.slice(at, stop));
        const close = html.indexOf(">", stop);
        at = re.lastIndex = close < 0 ? html.length : close + 1;
        continue;
      }
      cur = el;
    }
  }
  if (at < html.length) cur.children.push(decode(html.slice(at)));
  return root;
}

const isEl = (c: Child): c is El => typeof c !== "string";
const classes = (e: El) => (e.attrs.class ?? "").split(/\s+/);
const hasClass = (e: El, c: string) => classes(e).includes(c);

function find(e: El, pred: (x: El) => boolean): El | null {
  for (const c of e.children) {
    if (!isEl(c)) continue;
    if (pred(c)) return c;
    const f = find(c, pred);
    if (f) return f;
  }
  return null;
}

function textOf(e: Child): string {
  return isEl(e) ? e.children.map(textOf).join("") : e;
}

// ---- MathML to LaTeX --------------------------------------------------------

const SYMBOLS: Record<string, string> = {
  α: "\\alpha", β: "\\beta", γ: "\\gamma", δ: "\\delta", ε: "\\epsilon", ϵ: "\\epsilon", ζ: "\\zeta",
  η: "\\eta", θ: "\\theta", ϑ: "\\vartheta", ι: "\\iota", κ: "\\kappa", λ: "\\lambda", μ: "\\mu",
  ν: "\\nu", ξ: "\\xi", π: "\\pi", ρ: "\\rho", σ: "\\sigma", ς: "\\varsigma", τ: "\\tau",
  υ: "\\upsilon", φ: "\\phi", ϕ: "\\phi", χ: "\\chi", ψ: "\\psi", ω: "\\omega",
  Γ: "\\Gamma", Δ: "\\Delta", Θ: "\\Theta", Λ: "\\Lambda", Ξ: "\\Xi", Π: "\\Pi", Σ: "\\Sigma",
  Υ: "\\Upsilon", Φ: "\\Phi", Ψ: "\\Psi", Ω: "\\Omega",
  "×": "\\times", "÷": "\\div", "·": "\\cdot", "⋅": "\\cdot", "±": "\\pm", "∓": "\\mp",
  "≤": "\\le", "≥": "\\ge", "≠": "\\neq", "≈": "\\approx", "≡": "\\equiv", "∼": "\\sim",
  "∝": "\\propto", "∞": "\\infty", "∂": "\\partial", "∇": "\\nabla", "∑": "\\sum", "∏": "\\prod",
  "∫": "\\int", "∮": "\\oint", "→": "\\to", "←": "\\leftarrow", "⇒": "\\Rightarrow",
  "⇐": "\\Leftarrow", "⇔": "\\Leftrightarrow", "↔": "\\leftrightarrow", "↦": "\\mapsto",
  "∈": "\\in", "∉": "\\notin", "∋": "\\ni", "⊂": "\\subset", "⊆": "\\subseteq", "⊃": "\\supset",
  "⊇": "\\supseteq", "∪": "\\cup", "∩": "\\cap", "∅": "\\emptyset", "∀": "\\forall",
  "∃": "\\exists", "¬": "\\neg", "∧": "\\land", "∨": "\\lor", "⊕": "\\oplus", "⊗": "\\otimes",
  "−": "-", "′": "'", "″": "''", "…": "\\ldots", "⋯": "\\cdots", "∘": "\\circ", "°": "^\\circ",
  "ℝ": "\\mathbb{R}", "ℕ": "\\mathbb{N}", "ℤ": "\\mathbb{Z}", "ℚ": "\\mathbb{Q}", "ℂ": "\\mathbb{C}",
  "⟨": "\\langle", "⟩": "\\rangle", "‖": "\\|", "∣": "|", "⌊": "\\lfloor", "⌋": "\\rfloor",
  "⌈": "\\lceil", "⌉": "\\rceil", "ℓ": "\\ell", "ℏ": "\\hbar",
  "%": "\\%", "#": "\\#", "&": "\\&", "{": "\\{", "}": "\\}", "_": "\\_", $: "\\$",
  " ": " ",
};
const INVISIBLE = /[⁡-⁤​]/g;
const FUNCTIONS = new Set([
  "sin", "cos", "tan", "cot", "sec", "csc", "sinh", "cosh", "tanh", "log", "ln", "lg", "exp",
  "lim", "max", "min", "sup", "inf", "det", "arg", "deg", "gcd", "dim", "ker", "arcsin", "arccos", "arctan", "Pr",
]);
const ACCENTS: Record<string, string> = {
  "^": "\\hat", ˆ: "\\hat", "¯": "\\bar", ˉ: "\\bar", "‾": "\\overline", "→": "\\vec", "⃗": "\\vec",
  "~": "\\tilde", "˜": "\\tilde", "˙": "\\dot", "¨": "\\ddot", "⏞": "\\overbrace",
};
const UNDER_ACCENTS: Record<string, string> = { "⏟": "\\underbrace", "_": "\\underline", "¯": "\\underline" };
const BIG = new Set(["\\sum", "\\prod", "\\int", "\\oint", "\\lim", "\\max", "\\min", "\\sup", "\\inf", "\\bigcup", "\\bigcap"]);

/** Math alphanumerics (𝑥, 𝐀, 𝟎) back to their letter; then the symbol table. */
function plainChar(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp === 0x210e) return "h";
  if (cp >= 0x1d400 && cp <= 0x1d6a3) {
    const i = (cp - 0x1d400) % 52;
    return String.fromCharCode(i < 26 ? 65 + i : 97 + i - 26);
  }
  if (cp >= 0x1d7ce && cp <= 0x1d7ff) return String.fromCharCode(48 + ((cp - 0x1d7ce) % 10));
  return ch;
}

function symbols(s: string): string {
  return Array.from(s.replace(INVISIBLE, ""))
    .map((ch) => {
      const p = plainChar(ch);
      return SYMBOLS[p] ?? p;
    })
    .join("");
}

/** Join pieces, keeping a control word from running into a letter (`\alpha x`). */
function join(parts: string[]): string {
  let out = "";
  for (const p of parts) {
    if (!p) continue;
    if (/\\[A-Za-z]+$/.test(out) && /^[A-Za-z]/.test(p)) out += " ";
    out += p;
  }
  return out;
}

/** A piece as one TeX argument: braced unless it is one character or one command. */
function arg(s: string): string {
  return s.length === 1 || /^\\[A-Za-z]+$/.test(s) ? s : `{${s}}`;
}

function kids(e: El): El[] {
  return e.children.filter(isEl);
}

export function mathmlToTex(e: Child): string {
  if (!isEl(e)) return symbols(e.trim());
  const k = kids(e);
  const c = (i: number) => (k[i] ? mathmlToTex(k[i]) : "");
  const all = () => join(k.map(mathmlToTex));
  switch (e.tag) {
    case "annotation":
    case "annotation-xml":
    case "mphantom":
    case "mspace":
    case "none":
    case "mprescripts":
      return "";
    case "semantics":
      return k[0] ? mathmlToTex(k[0]) : "";
    case "mi": {
      const t = textOf(e).replace(INVISIBLE, "").trim();
      if (Array.from(t).length <= 1) return symbols(t);
      if (FUNCTIONS.has(t)) return `\\${t}`;
      return `\\mathrm{${t}}`;
    }
    case "mn":
      return symbols(textOf(e).trim());
    case "mo": {
      const t = textOf(e).replace(INVISIBLE, "").trim();
      if (FUNCTIONS.has(t)) return `\\${t}`;
      return symbols(t);
    }
    case "mtext": {
      const t = textOf(e).replace(/\s+/g, " ");
      return t.trim() ? `\\text{${t}}` : "";
    }
    case "ms":
      return `\\text{"${textOf(e)}"}`;
    case "msup":
      return `${arg(c(0))}^${arg(c(1))}`;
    case "msub":
      return `${arg(c(0))}_${arg(c(1))}`;
    case "msubsup":
      return `${arg(c(0))}_${arg(c(1))}^${arg(c(2))}`;
    case "mfrac":
      return e.attrs.linethickness === "0" || e.attrs.linethickness === "0px"
        ? `\\binom{${c(0)}}{${c(1)}}`
        : `\\frac{${c(0)}}{${c(1)}}`;
    case "msqrt":
      return `\\sqrt{${all()}}`;
    case "mroot":
      return `\\sqrt[${c(1)}]{${c(0)}}`;
    case "mover": {
      const base = c(0);
      const over = textOf(k[1] ?? "").trim();
      if (ACCENTS[over]) return `${ACCENTS[over]}{${base}}`;
      if (BIG.has(base)) return `${base}^${arg(c(1))}`;
      return `\\overset{${c(1)}}{${base}}`;
    }
    case "munder": {
      const base = c(0);
      const under = textOf(k[1] ?? "").trim();
      if (UNDER_ACCENTS[under]) return `${UNDER_ACCENTS[under]}{${base}}`;
      if (BIG.has(base)) return `${base}_${arg(c(1))}`;
      return `\\underset{${c(1)}}{${base}}`;
    }
    case "munderover": {
      const base = c(0);
      if (BIG.has(base)) return `${base}_${arg(c(1))}^${arg(c(2))}`;
      return `\\overset{${c(2)}}{\\underset{${c(1)}}{${base}}}`;
    }
    case "mfenced": {
      const open = e.attrs.open ?? "(";
      const close = e.attrs.close ?? ")";
      const sep = (e.attrs.separators ?? ",").trim()[0] ?? "";
      return symbols(open) + k.map(mathmlToTex).join(sep) + symbols(close);
    }
    case "mtable": {
      const rows = k.map((r) =>
        kids(r)
          .filter((d) => d.tag === "mtd")
          .map(mathmlToTex)
          .join(" & "),
      );
      return `\\begin{matrix}${rows.join(" \\\\ ")}\\end{matrix}`;
    }
    default:
      return all();
  }
}

// ---- finding the formulas ---------------------------------------------------

interface Formula {
  tex: string;
  display: boolean;
}

/** The TeX a formula element's annotation or `alttext` carries. */
function sourceOf(e: El): string | null {
  const ann = find(e, (x) => x.tag === "annotation" && /^(application\/x-tex|tex|latex)$/i.test(x.attrs.encoding ?? ""));
  const t = ann ? textOf(ann).trim() : "";
  if (t) return t;
  const withAlt = e.tag === "math" && e.attrs.alttext ? e : find(e, (x) => x.tag === "math" && !!x.attrs.alttext);
  if (withAlt?.attrs.alttext?.trim()) return withAlt.attrs.alttext.trim();
  for (const a of ["data-tex", "data-latex", "data-original-tex"]) if (e.attrs[a]?.trim()) return e.attrs[a].trim();
  return null;
}

/** MathJax v3's CHTML glyphs: `mjx-c1D465` is U+1D465, drawn by CSS, no text. */
function mjxGlyphs(e: El): string {
  const out: string[] = [];
  const go = (x: El) => {
    for (const c of classes(x)) {
      const m = /^mjx-c([0-9A-F]+)$/i.exec(c);
      if (m) out.push(symbols(String.fromCodePoint(parseInt(m[1], 16))));
    }
    kids(x).forEach(go);
  };
  go(e);
  return join(out);
}

function texOfUnit(e: El, visible: () => string): string {
  const src = sourceOf(e);
  if (src) return src;
  const math = e.tag === "math" ? e : find(e, (x) => x.tag === "math");
  if (math) {
    const t = mathmlToTex(math).trim();
    if (t) return t;
  }
  if (e.tag === "mjx-container") {
    const g = mjxGlyphs(e).trim();
    if (g) return g;
  }
  return visible().replace(/\s+/g, " ").trim();
}

/** `{\displaystyle x}` (Wikipedia) → `x`; inline TeX on one line. */
function cleanTex(tex: string, display: boolean): string {
  let t = tex.trim();
  const w = /^\{\\(displaystyle|textstyle)\s*([\s\S]*)\}$/.exec(t);
  if (w) t = w[2].trim();
  return display ? t : t.replace(/\s+/g, " ");
}

/** The element is one formula: which, and whether it is display math. */
function formulaOf(e: El, scripts: Map<string, El>): Formula | null | "skip" {
  const cls = classes(e);
  if (cls.includes("katex-display") || (cls.includes("katex") && !(e.parent && hasClass(e.parent, "katex-display")))) {
    const display = cls.includes("katex-display");
    const html = find(e, (x) => hasClass(x, "katex-html"));
    return { tex: texOfUnit(e, () => (html ? textOf(html) : textOf(e))), display };
  }
  if (e.tag === "mjx-container") {
    return { tex: texOfUnit(e, () => ""), display: e.attrs.display === "true" };
  }
  if (cls.includes("mwe-math-element")) {
    const display = !!find(e, (x) => hasClass(x, "mwe-math-mathml-display") || (x.tag === "math" && x.attrs.display === "block"));
    const img = find(e, (x) => x.tag === "img" && !!x.attrs.alt);
    return { tex: texOfUnit(e, () => img?.attrs.alt ?? ""), display };
  }
  // MathJax v2: a rendered frame, then a `<script type="math/tex">` with
  // the source; the preview is a duplicate.
  if (cls.includes("MathJax_Preview")) return "skip";
  if ((cls.includes("MathJax") || cls.includes("MathJax_Display") || cls.includes("MathJax_SVG")) && e.attrs.id?.endsWith("-Frame")) {
    const script = scripts.get(e.attrs.id.slice(0, -"-Frame".length));
    const display = cls.includes("MathJax_Display") || (e.parent ? hasClass(e.parent, "MathJax_Display") : false);
    if (script) return { tex: textOf(script).trim(), display: display || /mode=display/.test(script.attrs.type ?? "") };
    if (e.attrs["data-mathml"]) return { tex: mathmlToTex(parseHtml(e.attrs["data-mathml"])).trim(), display };
    return null;
  }
  if (e.tag === "script" && /^math\/tex/i.test(e.attrs.type ?? "")) {
    if (e.attrs.id && e.attrs["data-frame-seen"]) return "skip";
    return { tex: textOf(e).trim(), display: /mode=display/.test(e.attrs.type ?? "") };
  }
  if (e.tag === "math") {
    return { tex: texOfUnit(e, () => textOf(e)), display: e.attrs.display === "block" };
  }
  return null;
}

// ---- the paste as text ------------------------------------------------------

const SKIP = new Set(["head", "style", "title", "meta", "link", "template", "noscript", "button", "svg"]);
const PARA = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "pre", "blockquote", "table", "figure", "dl"]);
const LINE = new Set(["div", "li", "tr", "section", "article", "header", "footer", "dt", "dd", "figcaption", "caption", "main", "nav", "aside"]);
const WORD = /[A-Za-z0-9_]$/;

/** Spaces and tabs off the end of `s`, by a loop: `/[ \t]+$/` is quadratic
 *  on a long run of spaces that is not at the end. */
function trimSpaces(s: string): string {
  let j = s.length;
  while (j > 0 && (s[j - 1] === " " || s[j - 1] === "\t")) j--;
  return j === s.length ? s : s.slice(0, j);
}

export function mathPasteText(html: string): string | null {
  if (!html || !/katex|<math|mjx-container|math\/tex|MathJax|mwe-math/i.test(html)) return null;
  // Review 2026-10-12: any failure (a paste nested deeper than the stack)
  // leaves the paste to go in as it always did.
  try {
    return convert(html);
  } catch {
    return null;
  }
}

function convert(html: string): string | null {
  const root = parseHtml(html);
  // MathJax v2 pairs: frame id `MathJax-Element-3-Frame` ↔ script id `MathJax-Element-3`.
  const scripts = new Map<string, El>();
  const collect = (e: El) => {
    if (e.tag === "script" && /^math\/tex/i.test(e.attrs.type ?? "") && e.attrs.id) scripts.set(e.attrs.id, e);
    kids(e).forEach(collect);
  };
  collect(root);

  // The output as pieces, read only at its end (review 2026-10-12): a
  // string read with end-anchored regexes after every piece was quadratic —
  // a 1.4 MB paste of display math took 28 s, a `<pre>` of 200k spaces 82 s.
  const parts: string[] = [];
  const last = (): string => {
    for (let i = parts.length - 1; i >= 0; i--) if (parts[i]) return parts[i][parts[i].length - 1];
    return "";
  };
  const put = (s: string) => {
    if (s) parts.push(s);
  };
  let found = 0;
  let glue = false; // the last thing written was inline math: a word after it needs a space
  const nl = (n: 1 | 2) => {
    if (!last()) return;
    while (parts.length) {
      const t = trimSpaces(parts[parts.length - 1]);
      if (t) {
        parts[parts.length - 1] = t;
        break;
      }
      parts.pop();
    }
    let have = 0;
    for (let i = parts.length - 1; i >= 0 && have < n; i--) {
      const p = parts[i];
      let j = p.length;
      while (j > 0 && p[j - 1] === "\n" && have < n) {
        j--;
        have++;
      }
      if (j > 0) break;
    }
    if (have < n) put("\n".repeat(n - have));
    glue = false;
  };
  const text = (s: string, pre: boolean) => {
    if (!pre) {
      s = s.replace(/\s+/g, " ");
      const l = last();
      if (!l || l === "\n" || l === " ") s = s.replace(/^ /, "");
    }
    if (!s) return;
    if (glue && /^[A-Za-z0-9_$]/.test(s)) put(" ");
    glue = false;
    put(s);
  };
  // Each `<ol>` item's place, worked out once per list rather than per item.
  const items = new Map<El, Map<El, number>>();
  const walk = (e: El, pre: boolean) => {
    for (const c of e.children) {
      if (!isEl(c)) {
        text(c, pre);
        continue;
      }
      const f = formulaOf(c, scripts);
      if (f === "skip") continue;
      if (f) {
        found++;
        const tex = cleanTex(f.tex, f.display);
        if (!tex) continue;
        if (f.display) {
          nl(1);
          put(`$$${tex}$$`);
          nl(1);
        } else {
          const l = last();
          if (WORD.test(l) || l === "$") put(" ");
          put(`$${tex}$`);
          glue = true;
        }
        if (c.attrs.id?.endsWith("-Frame")) {
          const s = scripts.get(c.attrs.id.slice(0, -"-Frame".length));
          if (s) s.attrs["data-frame-seen"] = "1";
        }
        continue;
      }
      if (SKIP.has(c.tag) || c.tag === "script") continue;
      if (/display\s*:\s*none/i.test(c.attrs.style ?? "")) continue;
      if (c.tag === "br") {
        nl(1);
        continue;
      }
      const block = PARA.has(c.tag) ? 2 : LINE.has(c.tag) ? 1 : 0;
      if (block) nl(block);
      if (c.tag === "li") {
        const list = c.parent;
        if (list?.tag === "ol") {
          let place = items.get(list);
          if (!place) {
            place = new Map(kids(list).filter((x) => x.tag === "li").map((x, i) => [x, i]));
            items.set(list, place);
          }
          const n = (place.get(c) ?? -1) + Number(list.attrs.start ?? 1);
          put(`${n}. `);
        } else put("- ");
      }
      if ((c.tag === "td" || c.tag === "th") && last() && last() !== "\n") {
        put("\t");
        glue = false; // a cell after a formula's cell: the tab parts them, no space (review 2026-10-12)
      }
      // `data-nl-ws` is set only by the app's own copy (item 352,
      // `mathCopy.ts`): the element's drawn white-space where it differs
      // from its parent's, so a pre-wrapped message keeps its line breaks.
      const ws = c.attrs["data-nl-ws"];
      walk(c, ws === "pre" ? true : ws === "normal" ? false : pre || c.tag === "pre");
      if (block) nl(block);
    }
  };
  walk(root, false);
  if (found === 0) return null;
  return parts
    .join("")
    .split("\n")
    .map(trimSpaces)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
