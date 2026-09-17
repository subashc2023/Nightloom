// An aside about a highlighted passage (nightshift backlog 107).
//
// The aside (backlog 081) is one question sent as one string to
// `ask_aside`; the backend knows nothing of selections. So the passage he
// highlighted travels inside that string, framed so the model reads it as
// a selection from the transcript rather than as something he typed: a
// line saying where it came from, the passage between triple quotes,
// exactly as selected, then his question. The model's own reply is in its
// context, so an exact quote is what lets it place the passage; the
// ordinal ("your 3rd reply") is a second handle for the same thing.

/** What he highlighted, and where. */
export interface AsideQuote {
  /** The selected text, as the selection read it (whitespace as is). */
  text: string;
  /** Whose message it came from. */
  role: "assistant" | "user";
  /** The message's 1-based place among the live messages of that role —
   *  the third reply, the second message of his — counted as the
   *  transcript draws them (a run of the model's messages is one reply,
   *  backlog 121). Rewound and removed messages are not counted: the
   *  CLI's history no longer has them. */
  ordinal: number;
}

/**
 * Where the passage came from, for the model ("your 3rd reply", "the
 * user's 1st message") or for the card he reads ("its 3rd reply", "your
 * 1st message") — the same place, the pronouns turned round.
 */
export function quoteLabel(q: AsideQuote, reader: "model" | "card" = "model"): string {
  const n = q.ordinal;
  const suffix =
    n % 100 >= 11 && n % 100 <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  const nth = `${n}${suffix}`;
  if (reader === "card") return q.role === "assistant" ? `its ${nth} reply` : `your ${nth} message`;
  return q.role === "assistant" ? `your ${nth} reply` : `the user's ${nth} message`;
}

/**
 * The one string the aside sends. `typed` is what he wrote in the card's
 * box; empty, the question defaults to "Explain this." — the box waits
 * for him, so this only guards a stray Enter on nothing.
 */
export function asideQuestion(q: AsideQuote, typed: string): string {
  const question = typed.trim() || "Explain this.";
  const passage = q.text.replace(/\s+$/, "").replace(/^\n+/, "");
  return [
    `The user selected this passage in the transcript, from ${quoteLabel(q)}, quoted exactly:`,
    "",
    '"""',
    passage,
    '"""',
    "",
    question,
  ].join("\n");
}

/**
 * Whether a selection's two ends make a passage: both inside a prose
 * block of the same turn. `a` and `b` are the ends as the transcript
 * resolved them — the turn's log index and the prose element each end
 * sits in — or null for an end outside any prose. Two ends in different
 * turns, or one in a reply's words and the other in its tool result, are
 * not a passage; the pill stays hidden.
 */
export interface SelectionEnd {
  turn: number;
  /** An identity for the prose element, so two ends can be compared. */
  prose: unknown;
}

export function samePassage(a: SelectionEnd | null, b: SelectionEnd | null): boolean {
  return a !== null && b !== null && a.turn === b.turn && a.prose === b.prose;
}

// --- The selection as text the model can read -------------------------------
//
// `Selection.toString()` reads the rendered DOM, and a rendered equation is
// KaTeX's layout: subscripts, fraction rows and the hidden MathML each on
// their own line — `y=2·1[x / 1 / x / 2` for y = 2·1[x₁, x₂] (his report,
// 2026-09-17). The model then receives that, not the equation. KaTeX keeps
// the source in an `<annotation encoding="application/x-tex">` the
// sanitizer preserves (`markdown.ts`), so every equation the selection
// touches is replaced by its `$…$` source, and a selection that starts or
// ends inside one is widened to the whole equation — half a formula has
// no source to quote.

const BLOCKS = new Set(["P", "DIV", "LI", "PRE", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "TR", "UL", "OL"]);

function katexOf(node: Node | null): Element | null {
  let el: Element | null = node instanceof Element ? node : (node?.parentElement ?? null);
  while (el) {
    if (el.classList.contains("katex-display")) return el;
    if (el.classList.contains("katex") && !el.parentElement?.classList.contains("katex-display")) return el;
    el = el.parentElement;
  }
  return null;
}

function texOf(katex: Element): string | null {
  const ann = katex.querySelector('annotation[encoding="application/x-tex"]');
  const tex = ann?.textContent?.trim();
  if (!tex) return null;
  return katex.classList.contains("katex-display") ? `$$${tex}$$` : `$${tex}$`;
}

function walk(node: Node, out: string[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    out.push((node as Text).data);
    return;
  }
  if (!(node instanceof Element)) {
    for (const c of Array.from(node.childNodes)) walk(c, out);
    return;
  }
  if (node.classList.contains("katex-display") || node.classList.contains("katex")) {
    const tex = texOf(node);
    // A partial clone (the range cut through it) has no annotation; the
    // widening below makes that rare, and falling back to its text is
    // still better than dropping it.
    if (tex) {
      out.push(tex);
      return;
    }
  }
  if (node.tagName === "BR") {
    out.push("\n");
    return;
  }
  const block = BLOCKS.has(node.tagName);
  if (block) out.push("\n");
  for (const c of Array.from(node.childNodes)) walk(c, out);
  if (block) out.push("\n");
}

/** The selected passage with every equation as its LaTeX source. */
export function selectionText(range: Range): string {
  const r = range.cloneRange();
  const startEq = katexOf(r.startContainer);
  const endEq = katexOf(r.endContainer);
  if (startEq) r.setStartBefore(startEq);
  if (endEq) r.setEndAfter(endEq);
  const out: string[] = [];
  walk(r.cloneContents(), out);
  return out
    .join("")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
