import type { MarkedExtension, Tokens } from "marked";

/**
 * Strikethrough needs two tildes, never one.
 *
 * GFM lets a single `~` pair strike text, and `marked` follows it. A research
 * reply is full of single tildes meaning *about* — "he puts this at ~70%" —
 * and two of them in one paragraph struck everything between, silently, with
 * nothing in the model's text to blame. The rule here is the one every chat
 * product and Obsidian apply: `~~struck~~`, and a lone `~` is a character.
 *
 * Only `del` is replaced; the rest of the inline tokenizer is `marked`'s.
 */
const DOUBLE = /^~~(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))~~(?=[^~]|$)/;

export const tilde: MarkedExtension = {
  tokenizer: {
    del(src: string): Tokens.Del | undefined {
      const m = DOUBLE.exec(src);
      if (!m) return undefined;
      return {
        type: "del",
        raw: m[0],
        text: m[1],
        tokens: this.lexer.inlineTokens(m[1]),
      };
    },
  },
};
