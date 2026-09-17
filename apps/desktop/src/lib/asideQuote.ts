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

/** One earlier exchange of the aside, for a follow-up's framing. */
export interface AsidePrior {
  question: string;
  /** The answer as he saw it — the whole of it, or what had arrived when
   *  he stopped it. */
  answer: string;
}

/**
 * The string a follow-up sends (nightshift backlog 130). The CLI's aside
 * is single-shot — a fresh throwaway fork of the chat each time, with no
 * memory of the last aside — so the side conversation so far travels
 * inside the question, quoted the way the passage does: each earlier
 * question and answer between triple quotes, the passage first when there
 * is one, then what he typed now. The chat's own context is the fork's;
 * nothing here is written anywhere. The quote grows with the thread; the
 * cost of that is measured in the 130 report.
 */
const FENCE = '"""';
export function asideFollowUp(q: AsideQuote | null, prior: AsidePrior[], typed: string): string {
  const question = typed.trim() || "Go on.";
  const fence = (text: string) => [FENCE, text.replace(/\s+$/, "").replace(/^\n+/, ""), FENCE];
  const out: string[] = ["This is a side conversation beside the chat, not part of it."];
  if (q) {
    out.push(`It is about this passage the user selected in the transcript, from ${quoteLabel(q)}, quoted exactly:`, "", ...fence(q.text), "");
  }
  prior.forEach((p, i) => {
    out.push(i === 0 ? "Earlier in the side conversation, the user asked:" : "Then the user asked:", "", ...fence(p.question), "", "and you answered:", "", ...fence(p.answer), "");
  });
  out.push("Now the user asks:", "", question);
  return out.join("\n");
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
