// Item 463 — a fenced block that holds prose wraps like a paragraph.
//
// A hand-off's start prompt comes in a fence tagged `start-prompt`
// (handoff.svelte.ts asks for it, and reads it back from that tag), and a
// model often fences a prompt to paste as ```text or ```markdown. Item 384
// wrapped only blocks with no language: these got a language class and
// stayed one long line that scrolled sideways (his report, 2026-10-28:
// "Why do the handoffs keep getting bunched up like this into one line?").
//
// A block is drawn as prose — `<pre class="prose-block">`, wrapped by
// app.css, Copy kept — when its tag says so (`start-prompt`, anywhere on
// the fence line), or when its tag is a text-like one and its lines read as
// sentences. A block tagged with a programming language stays as it was.

import { Renderer, type MarkedExtension, type Tokens } from "marked";

/** The fence tag a hand-off's start prompt uses (handoff.svelte.ts, START_PROMPT_TAG). */
const START_PROMPT = /(^|\s)start-prompt(\s|$)/;

/** Tags that name no programming language: their block may be prose. */
const TEXT_TAGS = new Set(["", "text", "txt", "plain", "plaintext", "prompt", "markdown", "md", "none"]);

/**
 * Whether a block's lines read as sentences rather than a layout: some line
 * of eight words or more, three in five tokens words, and no drawing characters
 * (box lines, table pipes, columns lined up with runs of spaces), which a
 * wrap would break apart.
 */
export function readsAsProse(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return false;
  if (/[│┃├└┌┐┘┬┴┼─═║]|^\s*\|.*\|\s*$/m.test(text)) return false;
  if (lines.some((l) => /\S {3,}\S/.test(l.trim()))) return false;
  const isWord = (t: string) => /^[("'“‘]?[A-Za-z][A-Za-z'’-]*[)"'”’.,:;!?]*$/.test(t);
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.filter(isWord).length / tokens.length < 0.6) return false;
  return lines.some((l) => l.trim().split(/\s+/).filter(isWord).length >= 8);
}

/** Whether a fenced block, by its fence line's info string and its text, is prose to wrap. */
export function isProseBlock(text: string, info: string | undefined): boolean {
  const tag = (info ?? "").trim().toLowerCase();
  if (START_PROMPT.test(tag)) return true;
  const first = tag.split(/\s+/)[0] ?? "";
  return TEXT_TAGS.has(first) && readsAsProse(text);
}

const plain = new Renderer();

/** The marked extension: marked's own block, with the class on its `<pre>` when it is prose. */
export const proseBlocks: MarkedExtension = {
  renderer: {
    code(token: Tokens.Code) {
      if (token.codeBlockStyle === "indented" || !isProseBlock(token.text, token.lang)) return false;
      return plain.code(token).replace(/^<pre>/, '<pre class="prose-block">');
    },
  },
};
