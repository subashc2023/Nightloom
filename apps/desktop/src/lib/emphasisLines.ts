import { Tokenizer, type MarkedExtension, type Tokens } from "marked";
import { tilde } from "./tilde";

/**
 * Item 670 (his bug, 2026-11-12): bold, italics and strikethrough never cross a line break.
 *
 * CommonMark only stops an emphasis run at a blank line, so two stars on different lines of one paragraph pair up —
 * `*p = 5;` on one line and `int* q;` on the next drew everything between them italic while he wrote about C
 * pointers. In a chat message a newline is one he (or the model) typed on purpose — the box and the transcript wrap
 * long lines themselves — so a run that spans one is two unrelated marks far more often than a hard-wrapped phrase.
 * The rest is CommonMark's own: a `*` with a space inside it (`a * b`) neither opens nor closes; text in a code span
 * or a fenced block is never emphasis.
 *
 * Applied where a chat's text is drawn: the formatted message box (`composerEditor.ts`) and replies (`renderReply`,
 * which also draws a quote in his sent message). Notes and file views (`renderMarkdown`) keep CommonMark — they are
 * Markdown documents, often hard-wrapped, where a run over a line break is meant.
 */
export function crossesLine(text: string, from: number, to: number): boolean {
  return text.slice(from, to).includes("\n");
}

const star = (src: string): Tokens.Text => ({ type: "text", raw: src[0], text: src[0] });

/**
 * marked's tokenizers with the rule: a run that would span a line break is not one — its first mark is a character,
 * and the text after it is read again, so a later mark on the same line can still pair (`**argv;\nint**` → no bold;
 * `***a** b\nc*` → `*` then **a**).
 */
export const emphasisLines: MarkedExtension = {
  tokenizer: {
    emStrong(src: string, maskedSrc: string, prevChar = "") {
      const tok = Tokenizer.prototype.emStrong.call(this, src, maskedSrc, prevChar);
      if (tok && tok.raw.includes("\n")) return star(src) as unknown as Tokens.Em;
      return tok;
    },
    del(src: string) {
      const tok = (tilde.tokenizer!.del as (this: unknown, src: string) => Tokens.Del | undefined).call(this, src);
      if (tok && tok.raw.includes("\n")) return star(src) as unknown as Tokens.Del;
      return tok;
    },
  },
};
