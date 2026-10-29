import { Marked, type MarkedExtension, type Tokens } from "marked";

/**
 * The tagged hand-off prompt (nightshift item 464, 2026-10-28). One source of
 * truth for the next chat's first message: the model writes it between
 * `<handoff>` and `</handoff>` on lines of their own, as plain prose; the
 * reply shows it as a card ("Next chat's prompt", with the code blocks' own
 * Copy button) instead of the raw tags; and at the turn's end Nightloom keeps
 * it — on the thread for a thread chat (`threadHandoff.svelte.ts`), so the
 * thread's + opens the next chat with it in the box, and as the wrap-up's
 * start prompt for *Continue in a new chat* (`extractStartPrompt`).
 *
 * The card and the extraction read the reply through the same tokenizer, so
 * what he sees as a card is exactly what is kept: a tag inside a code fence
 * or inline code is text (the fence's tokenizer owns it), an unclosed tag is
 * text, and the last closed block wins.
 */

export const HANDOFF_OPEN = "<handoff>";
export const HANDOFF_CLOSE = "</handoff>";
/** The card's label. */
export const HANDOFF_LABEL = "Next chat's prompt";

/** The sentence the wrap-ups end with: where the prompt goes, and how. */
export const HANDOFF_ASK =
  "Put the prompt between a line holding only <handoff> and a line holding only </handoff> — plain prose, " +
  "no code fence, no [brackets] or placeholders. Nightloom keeps it and opens the next chat with it in the " +
  "box, so do not tell me to copy it.";

interface HandoffToken extends Tokens.Generic {
  type: "handoff";
  raw: string;
  text: string;
}

/** A block at the start of `src`: the open tag at a line's start (up to three
 *  spaces in, as any block), the text, the close tag. A second open tag
 *  before the close means the first was never closed: not a block. */
const BLOCK = /^ {0,3}<handoff>[ \t]*\n?([\s\S]*?)<\/handoff>[ \t]*(?:\n+|$)/;
const START = /^ {0,3}<handoff>/m;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export const handoffTag: MarkedExtension = {
  extensions: [
    {
      name: "handoff",
      level: "block",
      start(src: string): number | undefined {
        const i = src.search(START);
        return i < 0 ? undefined : i;
      },
      tokenizer(src: string): HandoffToken | undefined {
        const m = BLOCK.exec(src);
        if (!m || m[1].includes(HANDOFF_OPEN)) return undefined;
        return { type: "handoff", raw: m[0], text: m[1].trim() };
      },
      renderer(token: Tokens.Generic): string {
        const text = (token as HandoffToken).text;
        if (!text) return "";
        // A `pre` with no language wraps like prose (app.css, backlog 384)
        // and gets the code blocks' Copy button (codeCopy.ts), which copies
        // the text exactly as kept.
        return (
          `<div class="handoff-card"><div class="handoff-label">${HANDOFF_LABEL}</div>` +
          `<pre class="handoff-text"><code>${escapeHtml(text)}</code></pre></div>\n`
        );
      },
    },
  ],
};

const reader = new Marked();
reader.use(handoffTag);

/**
 * The last `<handoff>` block of a reply, trimmed; null when there is none,
 * it is blank, it sits inside a code fence or inline code, or it was never
 * closed. Read only from a finished reply (a turn's end), never mid-stream.
 */
export function extractHandoff(reply: string): string | null {
  if (!reply.includes(HANDOFF_OPEN)) return null;
  let last: string | null = null;
  const tokens = reader.lexer(reply);
  reader.walkTokens(tokens, (t) => {
    if (t.type === "handoff") last = (t as HandoffToken).text;
  });
  const text = (last ?? "").trim();
  return text ? text : null;
}
