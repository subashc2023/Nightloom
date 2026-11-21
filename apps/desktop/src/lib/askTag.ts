import { Marked, type MarkedExtension, type Token, type Tokens } from "marked";
import type { SessionEvent } from "./types";

/**
 * The turn-end question (nightshift item 753, 2026-11-16): a turn that has to
 * end on a question for him ends on one tagged block,
 *
 *     <ask>
 *     The question, in full sentences.
 *     - The default answer
 *     - The other answer
 *     </ask>
 *
 * (`ASK_NOTE` in the service's `prompt.rs` tells every chat). The reply shows
 * the block as a quiet "Question for you" box; while it is the chat's last
 * word — no message of his after it — the transcript draws the question card
 * under it (`TurnAsk.svelte`, 712's `AskQuestions` with a click that sends),
 * and the Needs-you view lists it. A click sends the answer as his next
 * message and files it as an answered blocker (`needsBoard.svelte.ts`).
 *
 * The same rules as the hand-off tag (`handoffTag.ts`): read through one
 * tokenizer, so a tag inside a code fence or inline code is text, an unclosed
 * tag is text, and the last closed block wins.
 */

export const ASK_OPEN = "<ask>";
/** The box's label in a reply. */
export const ASK_LABEL = "Question for you";
/** The most answers a card draws; the prompt asks for one or two. */
export const ASK_MAX_OPTIONS = 4;

export interface Ask {
  question: string;
  /** The answers offered, the model's default first; may be empty (he types one). */
  options: string[];
}

interface AskToken extends Tokens.Generic {
  type: "ask";
  raw: string;
  ask: Ask;
}

const BLOCK = /^ {0,3}<ask>[ \t]*\n?([\s\S]*?)<\/ask>[ \t]*(?:\n+|$)/;
const START = /^ {0,3}<ask>/m;
const OPTION = /^\s*(?:[-*•]|\d+[.)])\s+(.*\S)\s*$/;

/** The block's inside as a question and its answers: the lines before the
 *  first list line are the question (joined), each list line an answer, bold
 *  and backticks dropped. Null without a question. */
export function parseAsk(inner: string): Ask | null {
  const question: string[] = [];
  const options: string[] = [];
  for (const line of inner.split("\n")) {
    const m = OPTION.exec(line);
    if (m) {
      const label = m[1].replace(/\*\*|__|`/g, "").trim();
      if (label && !options.includes(label) && options.length < ASK_MAX_OPTIONS) options.push(label);
    } else if (options.length === 0 && line.trim()) {
      question.push(line.trim());
    }
  }
  const q = question.join(" ").replace(/\*\*|__/g, "").trim();
  return q ? { question: q, options } : null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export const askTag: MarkedExtension = {
  extensions: [
    {
      name: "ask",
      level: "block",
      start(src: string): number | undefined {
        const i = src.search(START);
        return i < 0 ? undefined : i;
      },
      tokenizer(src: string): AskToken | undefined {
        const m = BLOCK.exec(src);
        if (!m || m[1].includes(ASK_OPEN)) return undefined;
        const ask = parseAsk(m[1]);
        return ask ? { type: "ask", raw: m[0], ask } : undefined;
      },
      renderer(token: Tokens.Generic): string {
        const { question, options } = (token as AskToken).ask;
        const list = options.length
          ? `<ul class="nl-ask-o">${options.map((o) => `<li>${escapeHtml(o)}</li>`).join("")}</ul>`
          : "";
        return `<div class="nl-ask"><div class="nl-ask-h">${ASK_LABEL}</div><p class="nl-ask-q">${escapeHtml(question)}</p>${list}</div>\n`;
      },
    },
  ],
};

const askMarked = new Marked();
askMarked.use(askTag);

/** The last `<ask>` block of a reply; null when there is none (or only an
 *  unclosed or fenced one). */
export function extractAsk(text: string | null | undefined): Ask | null {
  if (!text || !text.includes(ASK_OPEN)) return null;
  let last: Ask | null = null;
  for (const t of askMarked.lexer(text) as Token[]) if (t.type === "ask") last = (t as unknown as AskToken).ask;
  return last;
}

/** A reply's words: its text blocks, in order. */
export function replyText(e: Extract<SessionEvent, { event: "assistant_message" }>): string {
  return e.blocks
    .map((b) => (b.type === "text" ? ((b as { text?: string }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The question a chat is waiting on him with: its last message is a reply
 * that holds an `<ask>` block. Anything he sent after it answered it.
 * `index` is that reply's place in the log (the card's key).
 */
export function pendingAsk(events: readonly SessionEvent[]): { ask: Ask; index: number } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event === "user_message") return null;
    if (e.event === "assistant_message") {
      const ask = extractAsk(replyText(e));
      return ask ? { ask, index: i } : null;
    }
  }
  return null;
}

/** When he answered, as the blocker file says it: "2026-11-16 9:05 AM". */
export function answeredWhen(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const h = now.getHours();
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${h % 12 || 12}:${p(now.getMinutes())} ${h < 12 ? "AM" : "PM"}`;
}
