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
