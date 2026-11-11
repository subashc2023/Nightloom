import { Marked, type MarkedExtension, type Token, type Tokens } from "marked";

/**
 * The tagged hand-off prompt (nightshift item 464, 2026-10-28). One source of
 * truth for the next chat's first message: the model writes it between
 * `<handoff>` and `</handoff>` on lines of their own, as plain prose; the
 * reply shows it as a card ("Next chat's prompt", with the code blocks' own
 * Copy button) instead of the raw tags; and at the turn's end Nightloom keeps
 * it — on the thread for a thread chat (`threadHandoff.svelte.ts`), so the
 * thread's + opens the next chat with it in the box, and as the wrap-up's
 * start prompt (`extractStartPrompt`). Since item 506 the card in the chat's
 * latest reply carries *Continue with this prompt* (`handoffButton.ts`).
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
  "no code fence, no [brackets] or placeholders. Nightloom shows it as a card with a button that starts the " +
  "next chat with it, so do not tell me to copy it.";

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

/** A heading or bold line that names a hand-off prompt (item 583): "## Handoff
 *  prompt for the next chat", "**Hand-off:**", "Next chat's prompt". */
const FALLBACK_TITLE = /hand[- ]?off|next chat[’']?s prompt/i;

function titleText(t: Token): string | null {
  if (t.type === "heading") return (t as Tokens.Heading).text;
  if (t.type === "paragraph") {
    const inner = ((t as Tokens.Paragraph).tokens ?? []).filter((x) => !(x.type === "text" && !x.raw.trim()));
    // A bold line alone, an end colon allowed ("**Handoff prompt:**" or "**Handoff prompt**:").
    const bold = inner[0];
    const rest = inner.slice(1).map((x) => x.raw).join("").trim();
    if (inner.length >= 1 && bold.type === "strong" && (rest === "" || rest === ":")) {
      return (bold as Tokens.Strong).text;
    }
  }
  return null;
}

/**
 * Item 583's fallback: a reply with no closed `<handoff>` block whose prompt
 * came as a fenced code block directly under a heading or bold line naming a
 * hand-off — the shape a model writes when he asks for the prompt in his own
 * words. The last such fence becomes the hand-off token, in place, so the card
 * shows and `extractHandoff` keeps it through the one path. A tagged block
 * anywhere wins and nothing is changed; an ordinary code block (no such title
 * right above it, or an indented one) is left alone.
 */
function promoteFallback(tokens: Token[]): Token[] {
  if (tokens.some((t) => t.type === "handoff")) return tokens;
  let at = -1;
  for (let i = 0; i < tokens.length; i++) {
    const title = titleText(tokens[i]);
    if (title === null || !FALLBACK_TITLE.test(title)) continue;
    let j = i + 1;
    while (j < tokens.length && tokens[j].type === "space") j++;
    const code = tokens[j] as Tokens.Code | undefined;
    if (code && code.type === "code" && code.codeBlockStyle !== "indented" && code.text.trim()) at = j;
  }
  if (at < 0) return tokens;
  const code = tokens[at] as Tokens.Code;
  const handoff: HandoffToken = { type: "handoff", raw: code.raw, text: code.text.trim() };
  tokens.splice(at, 1, handoff as unknown as Token);
  return tokens;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export const handoffTag: MarkedExtension = {
  hooks: {
    processAllTokens(tokens) {
      return promoteFallback(tokens as Token[]);
    },
  },
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
 * closed — except item 583's fallback ([`promoteFallback`]): with no closed
 * block, a fenced block right under a hand-off heading is the hand-off. Read only from a finished reply (a turn's end), never mid-stream.
 */
export function extractHandoff(reply: string): string | null {
  if (!reply.includes(HANDOFF_OPEN) && !FALLBACK_TITLE.test(reply)) return null;
  let last: string | null = null;
  // `lexer` runs no hooks: the fallback is applied here as `parse` applies it.
  const tokens = promoteFallback(reader.lexer(reply));
  reader.walkTokens(tokens, (t) => {
    if (t.type === "handoff") last = (t as HandoffToken).text;
  });
  const text = (last ?? "").trim();
  return text ? text : null;
}
