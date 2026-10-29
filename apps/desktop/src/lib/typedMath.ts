/**
 * Item 456: maths typed in plain text, offered back as LaTeX (`s^2` → `$s^2$`).
 *
 * The rules are the item-455 prototype's (nightshift-code
 * `notes/runner-design/455-math/`, measured there on 187 sentences: 0 of 53
 * unseen prose sentences fired, 64% of unseen maths converted whole), which is
 * why this is a suggestion he accepts and never an automatic rewrite.
 *
 * Two stages. Detection — the rules below — decides WHICH runs of words are
 * maths. Conversion turns a detected run into TeX with asciimath2tex (an
 * AsciiMath-to-TeX converter; AsciiMath is a plain-text maths notation such
 * as `sum_(i=1)^n` or `sqrt x`). AsciiMath cannot do the detecting itself: it
 * converts any input, so "a/b testing" would come back as
 * `\frac{a}{b} t e s t \in g`, and "choose" as `ch \infty se`.
 *
 * `findTypedMath(text)` returns the spans, each with its offsets, the text as
 * typed and the TeX; `applyTypedMath(text, spans)` wraps them as `$…$`.
 */

import AsciiMathParser from "asciimath2tex";

export interface TypedMathSpan {
  /** Offsets into the text, the span as typed. */
  from: number;
  to: number;
  /** The text as typed: `s^2`, "s squared". */
  src: string;
  /** The TeX, without delimiters: `s^{2}`. */
  tex: string;
}

let parser: AsciiMathParser | null = null;
function am(src: string): string {
  parser ??= new AsciiMathParser();
  return parser.parse(src);
}

const GREEK = new Set(
  "alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi rho sigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Phi Psi Omega".split(
    " ",
  ),
);
const FUNCS = new Set("sin cos tan sec csc cot log ln exp lim det".split(" "));
/** One-letter English words: never start a juxtaposition, never take "squared". */
const WEAK = new Set(["a", "A", "I"]);
/** Slash compounds that are prose, not fractions. */
const SLASH_PROSE = /^(and\/or|w\/o|w\/|s\/he|n\/a|i\/o|c\/o|tcp\/ip|a\/c|b\/w|y\/n)$/i;
const ORD: Record<string, string> = { second: "2", third: "3", fourth: "4", fifth: "5", nth: "n", kth: "k", mth: "m" };

const isNum = (s: string) => /^\d+(\.\d+)?$/.test(s);
const isLetter = (s: string) => /^[A-Za-z]$/.test(s);
/** dx, dy, dt */
const isDiff = (s: string) => /^d[a-z]$/.test(s);
/** A coefficient times letters: 3x, 4ac, 2Ax; not 2nd, 5th, 10am, 4px. */
const isCoef = (s: string) =>
  /^\d+[A-Za-z]{1,2}$/.test(s) && !/^\d+(st|nd|rd|th|am|pm|px|ms|kb|mb|gb|km|cm|mm|kg|lb|hz|ox|s|h|m|k)$/i.test(s);
function balanced(s: string): boolean {
  let d = 0;
  for (const c of s) {
    if (c === "(") d++;
    else if (c === ")") d--;
    if (d < 0) return false;
  }
  return d === 0;
}

// ---- protected regions: code, quotes, existing maths, URLs, paths, flags ----

function protectedRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  const add = (re: RegExp) => {
    for (const m of text.matchAll(re)) out.push([m.index, m.index + m[0].length]);
  };
  add(/```[\s\S]*?(```|$)/g); // a fence, closed or still being typed
  add(/`[^`\n]*`/g);
  add(/^>.*$/gm); // a quoted passage is someone else's words
  add(/\$\$[\s\S]*?\$\$/g);
  add(/\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g);
  add(/\$[^\s$][^$\n]*?[^\s$]\$|\$[^\s$]\$/g); // an existing inline formula
  add(/\$\d[\d,.]*/g); // prices
  add(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi);
  add(/\S+@\S+\.\S+/g);
  add(/(^|\s)(~?\.{0,2}\/\S+|\S+\/\S+\/\S*|\S+\/\S+\.[a-z]{1,5}\b)/gi); // paths
  add(/(^|\s)--?[A-Za-z]\S*/g); // command-line flags
  add(/\b\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}\b/g); // dates
  add(/\b\d+\.\d+\.\d+\b/g); // versions
  return out;
}

// ---- tokens --------------------------------------------------------------

interface Tok {
  s: string;
  from: number;
  to: number;
  prot: boolean;
  punct?: boolean;
  next?: string;
}

function tokenize(text: string): Tok[] {
  const prot = protectedRanges(text);
  const inProt = (a: number, b: number) => prot.some(([p, q]) => a < q && b > p);
  const toks: Tok[] = [];
  // A prime is maths, not a closing quote: y'', f'(x).
  const primed = (x: string) => /^[A-Za-z]'+$/.test(x) || /^[A-Za-z]+'+\(/.test(x);
  for (const m of text.matchAll(/\S+/g)) {
    let s = m[0];
    let from = m.index;
    while (/^["'“‘]/.test(s)) (s = s.slice(1)), from++;
    let punct = false;
    while (/[.,;:?!"'”’]$/.test(s) && !primed(s) && !(s.endsWith("!") && /^[A-Za-z0-9)]+!$/.test(s) && s.length <= 3)) {
      s = s.slice(0, -1);
      punct = true;
    }
    if (!s) continue;
    toks.push({ s, from, to: from + s.length, prot: inProt(from, from + s.length), punct });
  }
  const merged: Tok[] = [];
  for (let i = 0; i < toks.length; i++) {
    let t = toks[i];
    // A token that opens an unbalanced paren takes what follows: "O(n log n)".
    if (!t.prot && !balanced(t.s) && t.s.includes("(")) {
      let j = i;
      let s = t.s;
      while (j + 1 < toks.length && j - i < 6 && !balanced(s)) {
        j++;
        s = text.slice(t.from, toks[j].to);
      }
      // Re-take a closing paren that the punctuation strip removed.
      let to = t.from + s.length;
      while (!balanced(s) && text[to] === ")") (s += ")"), to++;
      if (balanced(s) && !toks.slice(i, j + 1).some((x) => x.prot)) {
        t = { s, from: t.from, to, prot: false, punct: toks[j].punct && to === toks[j].to };
        i = j;
      }
    }
    // "|x - 3|": an absolute value spread over several tokens.
    if (!t.prot && t.s.startsWith("|") && !t.s.slice(1).includes("|")) {
      for (let j = i + 1; j < toks.length && j - i < 6; j++) {
        if (toks[j].s.includes("|")) {
          const s = text.slice(t.from, toks[j].to);
          if (!toks[j].prot && (s.endsWith("|") || /\|[<>=]/.test(s))) {
            t = { s, from: t.from, to: toks[j].to, prot: false, punct: toks[j].punct };
            i = j;
          }
          break;
        }
      }
    }
    // A stray paren that no merge claimed: "(see x^2)".
    while (t.s.endsWith(")") && !balanced(t.s)) t = { ...t, s: t.s.slice(0, -1), to: t.to - 1 };
    while (t.s.startsWith("(") && !balanced(t.s)) t = { ...t, s: t.s.slice(1), from: t.from + 1 };
    if (t.s) merged.push(t);
  }
  return merged;
}

// ---- classifying one token -------------------------------------------------

/** An operand inside a compact token like "i=1", "x+y", "3x-4", "(a+b)". */
function compactOperand(p: string): boolean {
  if (!p) return false;
  if (isNum(p) || isLetter(p) || GREEK.has(p) || isDiff(p) || isCoef(p)) return true;
  if (/^\(.*\)$/.test(p)) return compactExpr(p.slice(1, -1)) !== null;
  return strongToken(p) !== null;
}

/** "x+y", "i=1", "x<=5": operands joined by operators with no spaces. */
function compactExpr(s: string): string | null {
  const parts = s.split(/(<=|>=|!=|->|[=<>+\-*|])/);
  if (parts.length < 3) return null;
  let letters = false;
  for (let k = 0; k < parts.length; k += 2) {
    if (!compactOperand(parts[k])) return null;
    if (/[A-Za-z]/.test(parts[k])) letters = true;
  }
  return letters ? s : null;
}

function strongPow(p: string): boolean {
  const e = p.slice(1);
  if (/^\(.+\)$/.test(e) && balanced(e)) return true;
  return /^(\d{1,3}|[A-Za-z]|-1|T)$/.test(e);
}

/** A token that is maths on its own: its AsciiMath source, or null. */
function strongToken(s: string, t?: Tok): string | null {
  if (/[@#&\\$`]/.test(s)) return null;
  // |x - 3|, |x|^2
  if (/^\|.+\|/.test(s)) {
    const m2 = /^\|(.+)\|(.*)$/.exec(s);
    if (m2) {
      const inner = m2[1].replace(/\s+/g, "");
      const rest = m2[2].replace(/\s+/g, "");
      if ((compactOperand(inner) || compactExpr(inner)) && (!rest || compactExpr("0" + rest) || strongPow(rest))) return s;
    }
  }
  // f(x), sin(x), sqrt(x), P(A|B), O(n log n), E[X], and powers of them: sin(x)^2
  let m = /^([A-Za-z]+)'*(\(.*\)|\[.*\])(\^.+)?$/.exec(s);
  if (m && balanced(m[2].replace(/\[/g, "(").replace(/\]/g, ")"))) {
    const name = m[1];
    const inner = m[2].slice(1, -1);
    const ok =
      name === "sqrt" ||
      FUNCS.has(name) ||
      ((name.length === 1 || name === "Var") &&
        /^[A-Za-z0-9|,=+\- ^_()']+$/.test(inner) &&
        !/[A-Za-z]{3,}/.test(inner.replace(/\b(log|ln|sin|cos|tan|exp)\b/g, "")));
    if (ok && (!m[3] || strongPow(m[3]))) return s;
  }
  // a primed variable: y', y''
  if (/^[A-Za-z]'+$/.test(s) && !WEAK.has(s[0])) return s;
  // y_hat, x_bar
  m = /^([A-Za-z]|[a-z]+)_(hat|bar)$/.exec(s);
  if (m && (isLetter(m[1]) || GREEK.has(m[1]))) return `${m[2]}(${m[1]})`;
  // slash fraction: X/Y (not 24/7, and/or, A/B testing)
  if (/^[^/]+\/[^/]+$/.test(s) && !SLASH_PROSE.test(s)) {
    const [a, b] = s.split("/");
    const side = (p: string) =>
      isNum(p) ||
      isLetter(p) ||
      isDiff(p) ||
      (/^\(.+\)$/.test(p) && balanced(p) && compactOperand(p)) ||
      /^[A-Za-z]\(.+\)$/.test(p) ||
      (strongToken(p) !== null && !p.includes("/"));
    const abTest = isLetter(a) && isLetter(b) && !!t?.next && /^(test|tests|testing|split|variant|variants)$/i.test(t.next);
    if (side(a) && side(b) && !(isNum(a) && isNum(b)) && !abTest) return s;
  }
  // (y - y_hat)^2: a bracketed expression raised to a power
  m = /^\((.+)\)(\^.+)$/.exec(s);
  if (m && balanced(`(${m[1]})`) && strongPow(m[2]) && compactExpr(m[1].replace(/\s+/g, ""))) return s;
  // powers: s^2, e^(i pi), A^T, 2^10, x^(n-1); not ^C
  if (/^[A-Za-z0-9]+\^/.test(s)) {
    const [base, ...rest] = s.split("^");
    const baseOk = isNum(base) || isLetter(base) || GREEK.has(base) || /^\d+[A-Za-z]$/.test(base);
    if (baseOk && rest.length === 1 && strongPow("^" + rest[0])) return s;
  }
  // subscripts: x_1, a_n, theta_0, a_(n-1), lim_(x->0); not file_name, __init__
  m = /^([A-Za-z]+)_(\(.+\)|[A-Za-z0-9]{1,3})(\^.+)?$/.exec(s);
  if (m && (isLetter(m[1]) || GREEK.has(m[1]) || FUNCS.has(m[1]) || m[1] === "sum" || m[1] === "int")) {
    const sub = m[2];
    const subOk = /^\(.+\)$/.test(sub)
      ? compactExpr(sub.slice(1, -1)) !== null || /^[A-Za-z0-9]+$/.test(sub.slice(1, -1))
      : /^(\d{1,3}|[A-Za-z]|[A-Za-z]{2}|[A-Za-z]\d)$/.test(sub) && sub.length !== 3;
    if (subOk && (!m[3] || strongPow(m[3]))) return s;
  }
  // factorial: n!
  if (/^([A-Za-z]|\d+)!$/.test(s) && !WEAK.has(s[0])) return s;
  // compact expressions: i=1, x+y, x<=5 (but not C++, x-ray, DEBUG=true, 1-2)
  if (compactExpr(s)) return s;
  return null;
}

type Kind = "STRONG" | "ATOM" | "GREEK" | "FUNC" | "OP" | "WORD";
interface Item {
  kind: Kind;
  from: number;
  to: number;
  am?: string;
  tex?: string;
  num?: boolean;
  weak?: boolean;
  diff?: boolean;
  coef?: boolean;
  spoken?: boolean;
  punct?: boolean;
  /** A word that looks like maths but was not understood: "t_(1/2)". */
  mathy?: boolean;
}
type Cls = Omit<Item, "from" | "to">;

function classify(t: Tok): Cls {
  const s = t.s;
  if (t.prot) return { kind: "WORD" };
  if (/^(=|\+|-|\*|<|>|<=|>=|!=|\/|->|\|)$/.test(s)) return { kind: "OP", am: s };
  if (GREEK.has(s)) return { kind: "GREEK", am: s };
  if (FUNCS.has(s)) return { kind: "FUNC", am: s };
  if (isNum(s)) return { kind: "ATOM", am: s, num: true };
  if (isLetter(s)) return { kind: "ATOM", am: s, weak: WEAK.has(s) };
  if (isDiff(s)) return { kind: "ATOM", am: s, diff: true };
  if (isCoef(s)) return { kind: "ATOM", am: s, coef: true }; // 3x (but "2x faster")
  const st = strongToken(s, t);
  if (st) return { kind: "STRONG", am: st };
  return { kind: "WORD" };
}

// ---- spoken phrases -> items -----------------------------------------------

const SPOKEN_OPS: [string[], string][] = [
  [["greater", "than", "or", "equal", "to"], ">="],
  [["less", "than", "or", "equal", "to"], "<="],
  [["not", "equal", "to"], "!="],
  [["greater", "than"], ">"],
  [["less", "than"], "<"],
  [["plus"], "+"],
  [["minus"], "-"],
  [["times"], "*"],
  [["equals"], "="],
  [["over"], "/"],
];

const operandItem = (it: Cls | undefined) => !!it && (it.kind === "ATOM" || it.kind === "GREEK" || it.kind === "STRONG");

function items(text: string): Item[] {
  const toks = tokenize(text);
  const cls = toks.map((t, k) => classify({ ...t, next: toks[k + 1]?.s.toLowerCase() }));
  const low = toks.map((t) => (t.prot ? "\u0000" : t.s.toLowerCase()));
  const at = (i: number, words: string[]) => words.every((w, k) => low[i + k] === w);
  const out: Item[] = [];
  const push = (kind: Kind, from: number, to: number, extra: Cls | Partial<Item>) => out.push({ ...extra, kind, from, to });
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    const c = cls[i];
    // "square root of X", "cube root of X": the radicand is the whole typed
    // run that follows ("square root of b^2 - 4ac"), up to a word or a comma.
    let rooted = false;
    for (const [w, idx] of [["square", 2], ["cube", 3]] as const) {
      if (at(i, [w, "root", "of"]) && operandItem(cls[i + 3]) && !cls[i + 3].weak) {
        let j = i + 3;
        const parts = [cls[j].am];
        while (
          !toks[j].punct &&
          j + 2 < toks.length &&
          cls[j + 1].kind === "OP" &&
          (operandItem(cls[j + 2]) || cls[j + 2].coef)
        ) {
          parts.push(cls[j + 1].am, cls[j + 2].am);
          j += 2;
        }
        const x = parts.join(" ");
        push("STRONG", t.from, toks[j].to, { am: idx === 2 ? `sqrt(${x})` : `root(3)(${x})`, punct: toks[j].punct });
        i = j + 1;
        rooted = true;
        break;
      }
    }
    if (rooted) continue;
    // "sum from i=1 to n [of]", "integral from 0 to 1 of"
    const big = at(i, ["sum", "from"]) ? "sum" : at(i, ["integral", "from"]) ? "int" : null;
    if (big && low[i + 3] === "to" && toks[i + 4]) {
      const lo = toks[i + 2].s;
      const hi = toks[i + 4].s;
      const okLo = !toks[i + 2].prot && (isNum(lo) || isLetter(lo) || compactExpr(lo) !== null);
      const okHi = !toks[i + 4].prot && (isNum(hi) || isLetter(hi) || GREEK.has(hi) || hi === "infinity");
      if (okLo && okHi) {
        const h = hi === "infinity" ? "oo" : hi;
        let j = i + 5;
        if (low[j] === "of") j++;
        push("STRONG", t.from, toks[i + 4].to, { am: `${big}_(${lo})^(${h})` });
        i = j;
        continue;
      }
    }
    // X squared / cubed / to the power of N / to the Nth [power] / sub N / choose K
    if (operandItem(c) && !c.weak) {
      let j = i + 1;
      let src = c.am ?? "";
      let to = t.to;
      let tex: string | null = null;
      let changed = true;
      while (changed) {
        changed = false;
        if (low[j] === "squared" || low[j] === "cubed") {
          src = `${src}^${low[j] === "squared" ? 2 : 3}`;
          to = toks[j].to;
          j++;
          changed = true;
        } else if (at(j, ["to", "the", "power", "of"]) && operandItem(cls[j + 4])) {
          src = `${src}^(${cls[j + 4].am})`;
          to = toks[j + 4].to;
          j += 5;
          changed = true;
        } else if (at(j, ["to", "the"]) && toks[j + 2]) {
          const o = low[j + 2];
          const n = ORD[o] ?? /^(\d+)(st|nd|rd|th)$/.exec(o)?.[1];
          if (n !== undefined) {
            src = `${src}^(${n})`;
            to = toks[j + 2].to;
            j += 3;
            if (low[j] === "power") (to = toks[j].to), j++;
            changed = true;
          }
        } else if ((low[j] === "sub" || low[j] === "subscript") && operandItem(cls[j + 1])) {
          src = `${src}_(${cls[j + 1].am})`;
          to = toks[j + 1].to;
          j += 2;
          changed = true;
        } else if (low[j] === "choose" && operandItem(cls[j + 1])) {
          tex = `\\binom{${texOf(src)}}{${texOf(cls[j + 1].am ?? "")}}`;
          to = toks[j + 1].to;
          j += 2;
          break;
        }
      }
      if (j > i + 1) {
        push("STRONG", t.from, to, tex ? { tex, punct: toks[j - 1].punct } : { am: src, punct: toks[j - 1].punct });
        i = j;
        continue;
      }
    }
    // spoken operators
    const op = SPOKEN_OPS.find(([words]) => at(i, words));
    if (op) {
      push("OP", t.from, toks[i + op[0].length - 1].to, { am: op[1], spoken: true });
      i += op[0].length;
      continue;
    }
    push(c.kind, t.from, t.to, { ...c, punct: t.punct, mathy: c.kind === "WORD" && !t.prot && /[_^=]|\w\(/.test(t.s) });
    i++;
  }
  return out;
}

// ---- runs of items -> spans -------------------------------------------------

/** "2 pi r", "pi r^2", "A^T A", "n x^(n-1)", "P(B|A) P(A)", "i^2 dx", "delta x" */
function juxtaposable(a: Item, b: Item): boolean {
  if (a.weak && b.kind !== "STRONG") return false;
  if (b.kind === "WORD" || a.kind === "WORD") return false;
  if (b.diff) return a.kind === "STRONG" || a.kind === "ATOM" || a.kind === "GREEK";
  if (a.kind === "FUNC") return b.kind !== "OP";
  if (b.kind === "FUNC") return false;
  if (a.kind === "STRONG" || b.kind === "STRONG") return !(a.num && b.num) && !b.weak;
  if (a.kind === "GREEK" || b.kind === "GREEK") return !a.coef && !b.coef && !b.weak;
  return false;
}

function accept(run: Item[]): boolean {
  if (run.some((x) => x.kind === "STRONG")) return true;
  const hasOp = run.some((x) => x.kind === "OP");
  const hasVar = run.some((x) => (x.kind === "ATOM" && !x.num) || x.kind === "GREEK");
  if (hasOp && hasVar) {
    const operands = run.filter((x) => x.kind !== "OP");
    // "a + b" between two one-letter words is too thin.
    if (operands.every((x) => x.weak)) return false;
    if (operands.some((x) => x.coef) && !run.some((x) => x.am === "=" || x.am === "+" || x.am === "-")) return false;
    return true;
  }
  // "2 pi r", "delta x": a Greek letter beside an operand
  return run.length >= 2 && run.some((x) => x.kind === "GREEK");
}

function spansOf(its: Item[]): Item[][] {
  const spans: Item[][] = [];
  let cur: Item[] = [];
  // A run with an operator cut off either edge is half a formula
  // ("$w = w - \eta$ * grad", "$T(n)$ = 2T(n/2)"): dropped, never half-wrapped.
  // A spoken operator left dangling is only a word ("the game is over").
  let lead = false;
  const flush = () => {
    let dangling = lead;
    while (cur.length && cur[cur.length - 1].kind === "OP") dangling ||= !cur.pop()!.spoken;
    while (cur.length && cur[0].kind === "OP") dangling ||= !cur.shift()!.spoken;
    if (cur.length && !dangling && accept(cur)) spans.push(cur);
    cur = [];
    lead = false;
  };
  for (let n = 0; n < its.length; n++) {
    const it = its[n];
    if (it.kind === "WORD") {
      flush();
      continue;
    }
    if (cur.length && cur[cur.length - 1].punct) flush();
    if (!cur.length) {
      if (it.kind !== "OP") cur.push(it);
      // An operator just after a word that is maths-shaped but not understood
      // ("t_(1/2) = …") also means the run is the tail of a formula.
      else if (!it.spoken && its[n - 1] && (its[n - 1].kind !== "WORD" || its[n - 1].mathy)) lead = true;
      continue;
    }
    const prev = cur[cur.length - 1];
    if (it.kind === "OP") {
      if (prev.kind === "OP") {
        flush();
        continue;
      }
      cur.push(it);
      continue;
    }
    // A one-letter word ("A", "I") after maths joins only when an operator
    // follows it: "A^T A = I", never "x^2 I think".
    const weakOk =
      !it.weak || prev.kind === "OP" || (prev.kind === "STRONG" && its[n + 1]?.kind === "OP" && !its[n + 1].spoken);
    if (prev.kind === "OP" || ((juxtaposable(prev, it) || (it.weak && prev.kind === "STRONG")) && weakOk)) {
      cur.push(it);
      continue;
    }
    flush();
    cur.push(it);
  }
  flush();
  return spans;
}

// ---- TeX ------------------------------------------------------------------

function tidy(tex: string): string {
  return tex
    .replace(/\{\\left \( (.*?) \\right \)\}/g, "($1)")
    .replace(/\\left \( /g, "(")
    .replace(/ \\right \)/g, ")")
    .replace(/\\left \\lvert /g, "|")
    .replace(/ \\right \\rvert/g, "|")
    .replace(/\\(log|ln|sin|cos|tan|exp)\{([^{}]*)\}/g, "\\$1 $2")
    .replace(/\s+/g, " ")
    .replace(/ '/g, "'")
    .trim();
}

/** Each pause re-reads the whole draft; its formulas are mostly the ones
 *  the last pause converted (about 0.4 ms each through AsciiMath). */
const texMemo = new Map<string, string>();
function texOf(src: string): string {
  let t = texMemo.get(src);
  if (t === undefined) {
    t = tidy(am(src.replace(/\b([A-Za-z])_(hat|bar)\b/g, "$2($1)")));
    if (texMemo.size >= 500) texMemo.clear();
    texMemo.set(src, t);
  }
  return t;
}

function texOfRun(run: Item[]): string {
  const parts: string[] = [];
  let buf: string[] = [];
  const take = () => {
    if (buf.length) parts.push(texOf(buf.join(" ")));
    buf = [];
  };
  for (let n = 0; n < run.length; n++) {
    const x = run[n];
    // AsciiMath binds "/" to the nearest simple term, so "P(A) / P(B)" parses
    // as P \frac{A}{P} (B); a call beside a spaced slash is grouped first.
    const bySlash = run[n - 1]?.am === "/" || run[n + 1]?.am === "/";
    if (bySlash && x.am && /^[A-Za-z]+\(.*\)$/.test(x.am)) {
      buf.push(`(${x.am})`);
      continue;
    }
    if (x.tex) {
      take();
      parts.push(x.tex);
    } else if (x.am) buf.push(x.am);
  }
  take();
  return parts.join(" ");
}

/** Every span of typed maths in `text`, in order. */
export function findTypedMath(text: string): TypedMathSpan[] {
  if (!/[A-Za-z0-9]/.test(text)) return [];
  return spansOf(items(text)).map((run) => {
    const from = run[0].from;
    const to = run[run.length - 1].to;
    return { from, to, src: text.slice(from, to), tex: texOfRun(run) };
  });
}

/**
 * `text` with `spans` wrapped as `$tex$` (spans in order, from `findTypedMath`
 * on this same text), and `caret` carried across the edits: a caret inside a
 * span lands after its formula.
 */
export function applyTypedMath(text: string, spans: TypedMathSpan[], caret = text.length): { text: string; caret: number } {
  let out = "";
  let k = 0;
  let c = caret;
  let shift = 0;
  for (const s of spans) {
    const rep = `$${s.tex}$`;
    out += text.slice(k, s.from) + rep;
    k = s.to;
    if (caret >= s.to) c = caret + shift + rep.length - (s.to - s.from);
    else if (caret > s.from) c = s.from + shift + rep.length;
    shift += rep.length - (s.to - s.from);
  }
  return { text: out + text.slice(k), caret: c };
}
