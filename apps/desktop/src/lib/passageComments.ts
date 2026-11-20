/*
 * Comments on passages, sent together (item 754; 736 synthesis row 8).
 *
 * He reads a long reply or a plan, highlights a passage and clicks the
 * selection pill's *Comment*: the passage becomes a chip over the message
 * box with a line for his comment under it. He goes on reading and
 * comments on more passages; each is a chip. Send sends one message: each
 * passage as a Markdown quote with his comment under it, in the order he
 * made them, then whatever he typed in the box itself. The sent bubble
 * draws the quotes as quotes (`splitQuotes`).
 *
 * The comments are part of the box's draft (`Draft.comments` in
 * `drafts.svelte.ts`): written to the drafts store as he types, so a chat
 * switch, a reload and a quit keep them (practices §7). Only Send, or ×
 * on a chip after its confirm, drops one.
 *
 * This file is the pure part: the shape, reading it back from storage,
 * the chip's words and the message that goes.
 */
import { quoteSummary } from "./asideQuote";
import { quoteBlock } from "./replyQuote.svelte";

/** Where the passage came from: a reply, his own message, the plan card,
 *  or a diff in a tool card. */
export type CommentSource = "reply" | "message" | "plan" | "diff";

export interface PassageComment {
  /** Unique among the comments on screen (per launch, like chip ids). */
  id: number;
  /** The passage as it is quoted (`selectionText`: maths as its source). */
  quote: string;
  source: CommentSource;
  /** Its 1-based place among the chat's replies or his messages; 0 when not known. */
  ordinal: number;
  /** What he wrote about it; may be empty (the quote alone goes then). */
  note: string;
}

const SOURCES: readonly CommentSource[] = ["reply", "message", "plan", "diff"];

/** Comments read back from storage; a malformed one costs only itself. Pure. */
export function readComments(v: unknown): PassageComment[] {
  if (!Array.isArray(v)) return [];
  const out: PassageComment[] = [];
  for (const c of v) {
    if (c === null || typeof c !== "object") continue;
    const m = c as Record<string, unknown>;
    if (typeof m.quote !== "string" || m.quote.trim() === "") continue;
    out.push({
      id: typeof m.id === "number" && Number.isInteger(m.id) ? m.id : 0,
      quote: m.quote,
      source: SOURCES.includes(m.source as CommentSource) ? (m.source as CommentSource) : "reply",
      ordinal: typeof m.ordinal === "number" && Number.isInteger(m.ordinal) && m.ordinal > 0 ? m.ordinal : 0,
      note: typeof m.note === "string" ? m.note : "",
    });
  }
  return out;
}

/** A plain copy for storage. Pure. */
export function copyComments(list: readonly PassageComment[] | undefined): PassageComment[] {
  return (list ?? []).map((c) => ({ id: c.id, quote: c.quote, source: c.source, ordinal: c.ordinal, note: c.note }));
}

function nth(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${s}`;
}

/** Where the passage is from, for the chip's hover: "its 3rd reply". Pure. */
export function commentWhere(c: Pick<PassageComment, "source" | "ordinal">): string {
  const at = c.ordinal > 0 ? ` ${nth(c.ordinal)}` : "";
  switch (c.source) {
    case "message":
      return `your${at} message`;
    case "plan":
      return "the plan";
    case "diff":
      return "a diff";
    default:
      return `its${at} reply`;
  }
}

/** The chip's words: the passage's first ~`max` characters on one line. Pure. */
export const COMMENT_CHARS = 48;
export function commentLabel(quote: string, max = COMMENT_CHARS): string {
  const one = quote.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max).trimEnd()}…` : one;
}

/** The chip's words for a comment: a diff's path header is skipped, so
 *  the chip shows the lines he picked. Pure. */
export function chipLabel(c: Pick<PassageComment, "quote" | "source">, max = COMMENT_CHARS, opts: { math?: boolean } = {}): string {
  if (c.source === "diff") return commentLabel(shownQuote(c).replace(/\n/g, " "), max);
  // Item 814: a quoted table or formula reads as the held passage's chip does.
  // Item 880: `math` keeps formulas as `$…$` for the chip's `MathText` (a diff is never maths).
  return quoteSummary(c.quote, max, opts);
}

/** The passage as the open comment line shows it: a diff without its
 *  path header (the model still gets the header). Pure. */
export function shownQuote(c: Pick<PassageComment, "quote" | "source">): string {
  if (c.source !== "diff") return c.quote;
  return c.quote
    .split("\n")
    .filter((l) => !/^(---|\+\+\+) /.test(l))
    .join("\n");
}

/** A diff passage as the model should read it: a fenced block keeps its
 *  `+`/`-` columns from reading as Markdown lists. Pure. */
function quotedPassage(c: PassageComment): string {
  if (c.source !== "diff") return quoteBlock(c.quote);
  const body = c.quote.replace(/\r\n?/g, "\n").replace(/^\n+|\s+$/g, "");
  return quoteBlock("```diff\n" + body + "\n```");
}

/**
 * The one message Send sends: each comment as its passage quoted, his
 * comment under it, a blank line between comments; then the box's own
 * text. With no comments it is `typed` unchanged — a plain send is not
 * touched. Pure.
 */
export function commentsMessage(comments: readonly PassageComment[] | undefined, typed: string): string {
  const list = (comments ?? []).filter((c) => c.quote.trim() !== "");
  if (list.length === 0) return typed;
  const parts = list.map((c) => {
    const q = quotedPassage(c);
    const note = c.note.trim();
    return note ? `${q}\n\n${note}` : q;
  });
  const rest = typed.trim();
  return rest ? `${parts.join("\n\n")}\n\n${rest}` : parts.join("\n\n");
}
