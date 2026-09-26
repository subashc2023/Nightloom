/*
 * Reply to a highlighted passage (nightshift backlog 215).
 *
 * Beside Ask aside, the selection pill has *Reply*: the passage goes into
 * the composer as a Markdown quote block (`> ` on each line) at the caret,
 * and the caret lands on the line after it, so the quote sits where he
 * talks about it — inline in his message, not an attachment to the whole
 * of it. Several replies stack wherever each was placed; the draft keeps
 * them like any other text (it is text). His sent message renders the
 * `> ` lines as a quote (`splitQuotes`, used by the transcript's bubble).
 *
 * The pill lives in `Transcript.svelte` and the caret in `Composer.svelte`;
 * `requestReply` is the channel between them: the transcript bumps a
 * sequence number and the composer, which owns the textarea and the draft
 * key, does the insertion.
 */

/** The passage as a Markdown quote block: each line behind `> `, a blank
 *  line inside it as a bare `>` (so the block does not end there). */
export function quoteBlock(passage: string): string {
  if (passage.trim() === "") return "";
  const lines = passage
    .replace(/\r\n?/g, "\n")
    .replace(/^\n+|\s+$/g, "")
    .split("\n");
  return lines.map((l) => (l.trim() === "" ? ">" : `> ${l}`)).join("\n");
}

/** `text` with the passage quoted in place of `[start, end)`, and the
 *  caret after it. The quote starts on a line of its own (a newline is
 *  added when the caret is mid-line) and is followed by a blank line —
 *  without it, Markdown's lazy continuation would pull the next words he
 *  types into the quote. Text after the caret is kept, after the caret. */
export function insertQuote(
  text: string,
  start: number,
  end: number,
  passage: string,
): { text: string; caret: number } {
  const block = quoteBlock(passage);
  if (!block) return { text, caret: end };
  const s = Math.max(0, Math.min(start, text.length));
  const e = Math.max(s, Math.min(end, text.length));
  const before = text.slice(0, s);
  let after = text.slice(e);
  // A quote directly after a line of his: one newline puts it on its own
  // line; after a previous quote a blank line keeps the two apart.
  let lead = "";
  if (before.length > 0 && !before.endsWith("\n")) lead = "\n";
  if (/(^|\n)>[^\n]*\n?$/.test(before)) lead = before.endsWith("\n") ? "\n" : "\n\n";
  // What follows: a blank line, then the caret. Newlines already there
  // after the caret count toward it.
  const have = /^\n*/.exec(after)?.[0].length ?? 0;
  after = after.slice(Math.min(have, 2));
  const trail = "\n\n";
  const out = before + lead + block + trail + after;
  return { text: out, caret: (before + lead + block + trail).length };
}

export type QuoteSegment = { kind: "quote" | "text"; text: string };

/** His message split into quote blocks (runs of lines starting `>`) and
 *  plain text, for the bubble to draw the quotes as quotes. A quote
 *  segment's text has the `> ` taken off; the blank line that ended a
 *  quote is dropped (the block's margin stands in for it). */
export function splitQuotes(text: string): QuoteSegment[] {
  const out: QuoteSegment[] = [];
  const lines = text.split("\n");
  let cur: QuoteSegment | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (!cur) return;
    let t = buf.join("\n");
    if (cur.kind === "text") t = t.replace(/^\n|\n$/g, "");
    if (cur.kind === "quote" || t.length > 0) out.push({ kind: cur.kind, text: t });
    cur = null;
    buf = [];
  };
  for (const line of lines) {
    // `> x` or a bare `>`: what `quoteBlock` writes. `>5` is not a quote.
    const m = /^>(?: (.*))?$/.exec(line);
    const kind = m ? "quote" : "text";
    if (!cur || cur.kind !== kind) {
      flush();
      cur = { kind, text: "" };
    }
    buf.push(m ? (m[1] ?? "") : line);
  }
  flush();
  return out;
}

/** The pending reply: the transcript sets it, the composer takes it. */
export const replyRequest = $state<{ seq: number; passage: string }>({ seq: 0, passage: "" });

export function requestReply(passage: string): void {
  replyRequest.passage = passage;
  replyRequest.seq += 1;
}

/** The pending passage, once: a second composer (or a re-run effect)
 *  finds nothing and inserts nothing. */
export function takeReply(): string | null {
  const p = replyRequest.passage;
  if (!p) return null;
  replyRequest.passage = "";
  return p;
}
