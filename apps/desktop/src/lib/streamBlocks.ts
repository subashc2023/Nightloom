/**
 * Item 830 — a streaming reply rendered block by block (2026-11-18: "my nightloom is very laggy / was scrolling up
 * and ggs" — the whole transcript went blank while a reply ran in his long STATS chat).
 *
 * Before, every delta sent the reply's whole text through marked, KaTeX and DOMPurify again (`renderReply`), and its
 * cache never hit, because each delta's text is new. The cost per delta grew with the reply: ~32 ms at 8,000
 * characters of maths (830 harness), at ~40 deltas a second — the main thread ran ~95% busy, frames took 70–330 ms,
 * and WebKit could not paint the tiles a scroll uncovered (the blank screen).
 *
 * Now the text is cut at block boundaries that are safe to cut at (below); every block before the last cut is
 * finished, and goes through the same renderer alone, where the cache keeps its HTML; only the tail after it is
 * rendered fresh per delta. The settled reply is never cut: it renders whole, as before.
 *
 * A cut is safe where rendering the two sides apart gives the same HTML as rendering them together: a blank line
 * outside a code fence and outside display maths, the next line starting a new top-level block (not indented, not a
 * list item, which would join the list before it, not raw HTML). Raw HTML or a `<handoff>` / `<ask>` tag ends the
 * cutting (everything from it on is the tail, as their blocks span blank lines), and a reference-style link
 * definition anywhere means no cut at all (it reaches every block).
 */
import { renderMarkdown, renderReply, streamingTail } from "./markdown";

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^ {0,3}([-*+]|\d{1,9}[.)])(\s|$)/;
const REF_DEF = /^ {0,3}\[[^\]\n]+\]:\s*\S/m;

/** The text's finished blocks and its tail: `blocks.join("") + tail === src`. */
export function settledBlocks(src: string): { blocks: string[]; tail: string } {
  if (REF_DEF.test(src)) return { blocks: [], tail: src };
  const lines = src.split("\n");
  const cuts: number[] = []; // character offsets where a new block may start
  let fence: string | null = null;
  let dollars = 0; // `$$` seen outside fences, mod 2
  let brackets = 0; // `\[` minus `\]`
  let offset = 0;
  let prevBlank = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const start = offset;
    offset += line.length + 1;
    // The last line may still be arriving: it never starts a finished block's successor.
    const last = i === lines.length - 1;
    if (fence) {
      const m = FENCE.exec(line);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = null;
      prevBlank = false;
      continue;
    }
    const blank = line.trim() === "";
    // Raw HTML, a handoff or ask tag: their blocks span blank lines, so the rest is the tail.
    const html = !blank && /^ {0,3}</.test(line);
    if (!blank && prevBlank && !last && dollars === 0 && brackets === 0 && !/^\s/.test(line) && !LIST_ITEM.test(line))
      cuts.push(start);
    if (html) break;
    const f = FENCE.exec(line);
    if (f) {
      fence = f[1];
      prevBlank = false;
      continue;
    }
    dollars = (dollars + (line.match(/(?<!\\)\$\$/g)?.length ?? 0)) % 2;
    brackets += (line.match(/\\\[/g)?.length ?? 0) - (line.match(/\\\]/g)?.length ?? 0);
    if (brackets < 0) brackets = 0;
    prevBlank = blank;
  }
  if (cuts.length === 0) return { blocks: [], tail: src };
  const blocks: string[] = [];
  let from = 0;
  for (const c of cuts) {
    blocks.push(src.slice(from, c));
    from = c;
  }
  return { blocks, tail: src.slice(from) };
}

/** A streaming reply's HTML (the Mac's transcript, both looks): `renderReply(streamingTail(text))`, by blocks. */
export function renderStreamingReply(text: string): string {
  const { blocks, tail } = settledBlocks(streamingTail(text));
  let html = "";
  for (const b of blocks) html += renderReply(b);
  return html + renderReply(tail);
}

/** The phone's renderer has no cache of its own; its finished blocks are kept here, the most recent few hundred. */
const phoneBlocks = new Map<string, string>();
const PHONE_BLOCKS = 400;

/** The phone's streaming reply (`Remote.svelte`): `renderMarkdown(streamingTail(text), opts)`, by blocks. */
export function renderStreamingMarkdown(text: string, opts: { breaks?: boolean; localImagesAsText?: boolean }): string {
  const { blocks, tail } = settledBlocks(streamingTail(text));
  const tag = `${opts.breaks ? 1 : 0}${opts.localImagesAsText ? 1 : 0}`;
  let html = "";
  for (const b of blocks) {
    const key = tag + b;
    let h = phoneBlocks.get(key);
    if (h === undefined) {
      h = renderMarkdown(b, opts);
      phoneBlocks.set(key, h);
      if (phoneBlocks.size > PHONE_BLOCKS) phoneBlocks.delete(phoneBlocks.keys().next().value as string);
    }
    html += h;
  }
  return html + renderMarkdown(tail, opts);
}
