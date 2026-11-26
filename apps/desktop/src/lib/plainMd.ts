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
  return plainLines(md).replace(/\s+/g, " ").trim();
}

export function plainFragment(s: string): string {
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
  return lead + body + trail;
}
