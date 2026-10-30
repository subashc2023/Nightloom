/**
 * Item 479 (his ask, 2026-10-29: "where like i didnt put the $$ on both
 * sides but like its clearly supposed to be latex … do the same suggest
 * thing", his example `4. \sigma{1, 2, 4}`): runs of bare LaTeX — written
 * without `$…$` — found in a draft, for item 456's typed-maths bar to offer
 * as "Wrap as maths". The TeX is the text as typed; accepting wraps it in
 * `$…$`, or `$$…$$` when the run is the whole line.
 *
 * What counts. A run needs at least one **LaTeX word**: a backslash
 * command from `COMMANDS` (Greek letters, `\frac`, `\overline`, `\sum`,
 * `\leq`, …), or a `^{…}` / `_{…}` brace group. A word with any backslash
 * command not in the list (`C:\Users`, `\n`, `\d+`) is not LaTeX, which
 * is what keeps paths, escapes and regexes out. The run then takes in its
 * neighbours on the line while they are maths-shaped — an operator (`=`,
 * `+`), a number, a single letter, `2x`, `f(x)` — and stops at the first
 * prose word. An operand at the run's edge stays only when an operator
 * joins it to the rest (`x = \frac{1}{2}`), so a list marker (`4.`) or an
 * article ("a \alpha particle") is left out. Last, KaTeX must render the
 * run (`throwOnError`), or nothing is offered.
 *
 * Never inside the regions `typedMath.ts` protects (code spans and fences,
 * quoted lines, existing `$…$` / `$$…$$` / `\(…\)` / `\[…\]`, URLs,
 * paths), nor a Windows path (`C:\…`, `\\server\…`).
 */

import katex from "katex";

/** The commands that make a word LaTeX. Text-mode and spacing commands
 *  are left out on purpose (`\n`, `\t`, `\b` are escapes far more often). */
const COMMANDS = new Set(
  (
    // Greek
    "alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi varpi " +
    "rho varrho sigma varsigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma " +
    "Upsilon Phi Psi Omega " +
    // structures and accents
    "frac dfrac tfrac sqrt binom overline underline overbrace underbrace hat widehat bar vec tilde widetilde " +
    "dot ddot mathbb mathcal mathrm mathbf mathit mathsf mathfrak boldsymbol operatorname text left right " +
    // big operators
    "sum prod coprod int iint iiint oint lim limsup liminf sup inf max min bigcup bigcap bigoplus bigotimes " +
    // relations and binary operators
    "leq le geq ge neq ne approx equiv sim simeq cong propto in notin ni subset subseteq supset supseteq " +
    "cup cap setminus times cdot div pm mp circ oplus otimes wedge vee neg lnot land lor mid nmid parallel " +
    "perp to rightarrow leftarrow Rightarrow Leftarrow leftrightarrow Leftrightarrow iff implies mapsto " +
    "gets ll gg prec succ " +
    // symbols and delimiters
    "infty partial nabla forall exists nexists emptyset varnothing aleph hbar ell Re Im angle triangle " +
    "ldots cdots vdots ddots dots langle rangle lfloor rfloor lceil rceil lvert rvert lVert rVert " +
    // functions
    "sin cos tan sec csc cot arcsin arccos arctan sinh cosh tanh log ln exp det dim ker deg gcd lcm Pr arg"
  ).split(" "),
);

/** Commands that are operators: an operand beside one belongs to the run
 *  (`4 \times 3`, `\sum_{i=1}^{n} i`). */
const OPERATORS = new Set(
  (
    "leq le geq ge neq ne approx equiv sim simeq cong propto in notin ni subset subseteq supset supseteq " +
    "cup cap setminus times cdot div pm mp circ oplus otimes wedge vee mid to rightarrow leftarrow Rightarrow " +
    "Leftarrow leftrightarrow Leftrightarrow iff implies mapsto ll gg sum prod int iint oint lim bigcup bigcap"
  ).split(" "),
);

export interface BareLatexSpan {
  from: number;
  to: number;
  src: string;
  /** The run is its line, whole: wrapped as `$$…$$`. */
  display: boolean;
}

type Cls = "L" | "O" | "N" | "W";
interface Chunk {
  from: number;
  to: number;
  s: string;
  cls: Cls;
  /** An L made of one operator command (with its scripts). */
  op?: boolean;
}

const OPERATOR_WORD = /^(=|\+|-|−|\*|\/|<|>|<=|>=|:=|\||≈|≤|≥|≠|→|×|·|,)$/;
/** Prose words that look like operands: never kept at a run's edge. */
const ARTICLES = new Set(["a", "I"]);
/** A differential (`dx`): kept at the edge of a run with an integral. */
const DIFFERENTIAL = /^d[a-z]$/;

function classify(s: string): Pick<Chunk, "cls" | "op"> {
  if (s.includes("$") || s.includes("`")) return { cls: "W" };
  const cmds = [...s.matchAll(/\\([A-Za-z]+)/g)].map((m) => m[1]);
  if (cmds.length > 0) {
    if (cmds.some((c) => !COMMANDS.has(c))) return { cls: "W" };
    if (!bracesBalanced(s)) return { cls: "W" };
    const op = /^\\([A-Za-z]+)([_^](\{[^{}]*\}|\w))*$/.exec(s);
    return { cls: "L", op: !!op && OPERATORS.has(op[1]) };
  }
  // A backslash with no command after it (`\\`, `\{`, `C:\`): not ours.
  if (s.includes("\\")) return { cls: "W" };
  if (/[_^]\{/.test(s)) return bracesBalanced(s) ? { cls: "L" } : { cls: "W" };
  if (OPERATOR_WORD.test(s)) return { cls: "O" };
  const bare = s.replace(/[.,;:!?]+$/, "");
  if (DIFFERENTIAL.test(bare)) return { cls: "N" };
  if (/^[A-Za-z]{2,}$/.test(bare)) return { cls: "W" };
  if (/^[A-Za-z0-9()+\-*/^_=.,'|<>]+$/.test(s) && s.length <= 12 && /[0-9+\-*/^_=()|<>]|^[A-Za-z][.,]?$/.test(s))
    return { cls: "N" };
  return { cls: "W" };
}

function bracesBalanced(s: string): boolean {
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "{") d++;
    else if (c === "}") d--;
    if (d < 0) return false;
  }
  return d === 0;
}

/** A line's words, a brace group kept whole across its spaces
 *  (`\sigma{1, 2, 4}` is one word). */
function chunks(line: string, offset: number): Chunk[] {
  const out: Chunk[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;
    const start = i;
    let depth = 0;
    while (i < line.length && (depth > 0 || !/\s/.test(line[i]))) {
      if (line[i] === "\\") i++;
      else if (line[i] === "{") depth++;
      else if (line[i] === "}") depth = Math.max(0, depth - 1);
      i++;
    }
    const s = line.slice(start, Math.min(i, line.length));
    out.push({ from: offset + start, to: offset + start + s.length, s, ...classify(s) });
  }
  return out;
}

/** Whether an operand at a run's edge stays, given its inner neighbour
 *  and the run. */
function joined(edge: Chunk, inner: Chunk | undefined, run: Chunk[]): boolean {
  if (!inner) return false;
  if (edge.cls === "N" && ARTICLES.has(edge.s)) return false;
  if (DIFFERENTIAL.test(edge.s.replace(/[.,;:!?]+$/, "")) && run.some((c) => /\i*o?int/.test(c.s))) return true;
  return inner.cls === "O" || (inner.cls === "L" && !!inner.op);
}

const katexOk = new Map<string, boolean>();
function renders(tex: string): boolean {
  let ok = katexOk.get(tex);
  if (ok === undefined) {
    try {
      katex.renderToString(tex, { throwOnError: true, strict: "ignore" });
      ok = true;
    } catch {
      ok = false;
    }
    if (katexOk.size > 500) katexOk.clear();
    katexOk.set(tex, ok);
  }
  return ok;
}

const WINDOWS_PATH = /(^|[\s(])([A-Za-z]:\\|\\\\[A-Za-z0-9])\S*/g;

/** Every run of bare LaTeX in `text`, in order, outside `protect`. */
export function findBareLatex(text: string, protect: [number, number][]): BareLatexSpan[] {
  if (!/\\[A-Za-z]|[_^]\{/.test(text)) return [];
  const prot = [...protect];
  for (const m of text.matchAll(WINDOWS_PATH)) prot.push([m.index, m.index + m[0].length]);
  const hit = (a: number, b: number) => prot.some(([x, y]) => a < y && b > x);
  const out: BareLatexSpan[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const cs = chunks(line, offset).map((c) => (c.cls !== "W" && hit(c.from, c.to) ? { ...c, cls: "W" as Cls } : c));
    let i = 0;
    while (i < cs.length) {
      if (cs[i].cls === "W") {
        i++;
        continue;
      }
      let j = i;
      while (j < cs.length && cs[j].cls !== "W") j++;
      let run = cs.slice(i, j);
      i = j;
      if (!run.some((c) => c.cls === "L")) continue;
      // Trim the edges: operators always; an operand unless joined.
      for (;;) {
        const n = run.length;
        if (n && (run[0].cls === "O" || (run[0].cls === "N" && !joined(run[0], run[1], run)))) run = run.slice(1);
        else if (n && (run[n - 1].cls === "O" || (run[n - 1].cls === "N" && !joined(run[n - 1], run[n - 2], run))))
          run = run.slice(0, -1);
        else break;
      }
      if (!run.some((c) => c.cls === "L")) continue;
      let from = run[0].from;
      let to = run[run.length - 1].to;
      // Sentence punctuation after the run is the sentence's.
      while (to > from && /[.,;:!?]/.test(text[to - 1])) to--;
      let src = text.slice(from, to);
      // An unmatched parenthesis at an edge is the prose's: "(see \alpha)".
      while (src.startsWith("(") && !parensBalanced(src)) {
        from++;
        src = src.slice(1);
      }
      while (src.endsWith(")") && !parensBalanced(src)) {
        to--;
        src = src.slice(0, -1);
      }
      if (!src || !parensBalanced(src) || !renders(src)) continue;
      out.push({ from, to, src, display: line.trim() === src });
    }
    offset += line.length + 1;
  }
  return out;
}

function parensBalanced(s: string): boolean {
  let d = 0;
  for (const c of s) {
    if (c === "(") d++;
    else if (c === ")") d--;
    if (d < 0) return false;
  }
  return d === 0;
}
