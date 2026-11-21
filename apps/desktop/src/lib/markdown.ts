import { askTag } from "./askTag";
import { Marked, marked, Renderer, type Tokens } from "marked";
import DOMPurify from "dompurify";
import { math, openMathAt, renderMath } from "./math";
import { tilde } from "./tilde";
import { emphasisLines } from "./emphasisLines";
import { cite } from "./cite";
import { proseBlocks } from "./proseBlock";
import { handoffTag } from "./handoffTag";
import { isRunFence, markRunFence } from "./shellRun";
import "katex/dist/katex.min.css";
// Item 837: a formula keeps its case and spacing under any parent (desktop and phone both load this file).
import "./mathBase.css";
import { isLocalTarget, mediaKindOf } from "./replyMedia";
import { replyPage } from "./replyPage";
import { diagramBlock } from "./diagramBlock";
import { evidenceBlock } from "./evidenceBlock";

marked.use(math);
marked.use(tilde);
// Item 821: a ```mermaid or ```svg block is a diagram placeholder in every markdown surface (diagrams.ts draws it).
marked.use(diagramBlock);
// Item 798: an ```evidence block is a checked evidence table (evidenceTables.ts draws it from its file).
marked.use(evidenceBlock);

/**
 * KaTeX wraps its glyphs in a copy of the formula as MathML, which is what a
 * screen reader reads and what a selection copies. DOMPurify's default list
 * drops `<semantics>` and `<annotation>` — but it keeps their *contents*, so
 * the default is not "no MathML", it is the TeX source loose inside the
 * `<math>` element with nothing left to say it is an annotation.
 *
 * `annotation-xml` is deliberately not added back: that one is an HTML
 * integration point, which is to say the way markup gets smuggled through
 * MathML, and it is why the whole family is off by default. `<semantics>`
 * and `<annotation>` are inert containers and KaTeX emits nothing else.
 */
const ALLOW_MATHML = { ADD_TAGS: ["semantics", "annotation"] };

/**
 * What every reply and note is sanitised with. A `<style>` element is on
 * DOMPurify's default list, and its CSS applies to the whole window, not to
 * the reply it came in: a reply could restyle the app, cover an approval
 * card, or (the app sets no CSP) fetch a `url()` from any server (item 505,
 * found by the 503 review; his yes, blocker 1657). KaTeX styles through
 * `style` attributes, which stay.
 */
export const SANITIZE = { ...ALLOW_MATHML, FORBID_TAGS: ["style"] };

/** marked's options for `renderMarkdown` (pure, for the tests). */
export function markdownOptions(opts: { breaks?: boolean } = {}): { async: false; gfm: true; breaks: boolean } {
  return { async: false, gfm: true, breaks: opts.breaks === true };
}

/**
 * Item 820: a markdown image whose target is a file on this Mac
 * (`![plot](plot.png)`) drew a broken-image box — the webview resolves it
 * against the app's own origin. In a reply it is its alt text instead, and
 * the picture itself is drawn under the text by `ReplyMedia`, read through
 * the Mac's rules. A web image (`https:`, `data:`) renders as before.
 */
const escapeHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const localImageAsText = {
  renderer: {
    image(token: Tokens.Image) {
      const local = token.href.startsWith("file://") || isLocalTarget(token.href);
      if (!local) return false;
      const name = token.href.slice(token.href.lastIndexOf("/") + 1);
      const alt = `<em class="md-local-img">${escapeHtml(token.text || name)}</em>`;
      // Item 875: a picture or a video is drawn where the reply put it —
      // `replyMediaInline.ts` mounts it in this placeholder, read through the
      // same rules as 820's strip. The alt text stays inside, shown wherever
      // nothing mounts (a quote, a surface without the action).
      if (!mediaKindOf(localMediaTarget(token.href))) return alt;
      return `<span class="${MEDIA_CLASS}" data-media-src="${encodeURIComponent(token.href)}" data-media-alt="${encodeURIComponent(token.text)}">${alt}</span>`;
    },
  },
};

/** Item 875: the placeholder a local picture or video leaves in a reply's HTML. */
export const MEDIA_CLASS = "md-media";

/** A markdown image's target as a path: percent-decoded, `file://` dropped (as 820's `mediaCandidates` reads it). */
export function localMediaTarget(href: string): string {
  let w = href.trim();
  try {
    w = decodeURI(w);
  } catch {
    // A target that is not valid percent-encoding stays as written.
  }
  return w.replace(/^file:\/\//, "");
}

const inlineCache = new Map<string, string[]>();
/**
 * Item 875: the local pictures and videos a reply draws in place — every
 * markdown image marked parses (so one inside code, or a half-typed one,
 * is not), as paths, in order. The strip under the reply leaves these out.
 */
export function inlineMediaTargets(src: string): string[] {
  const hit = inlineCache.get(src);
  if (hit) return hit;
  const out: string[] = [];
  if (src.includes("![")) {
    replyMarked.walkTokens(replyMarked.lexer(src), (t) => {
      if (t.type !== "image") return;
      const href = (t as Tokens.Image).href;
      if (!(href.startsWith("file://") || isLocalTarget(href))) return;
      const path = localMediaTarget(href);
      if (mediaKindOf(path)) out.push(path);
    });
  }
  if (inlineCache.size > 200) inlineCache.delete(inlineCache.keys().next().value!);
  inlineCache.set(src, out);
  return out;
}

/** The phone's replies (item 820): `renderMarkdown`'s, with a local image as its alt text. */
const phoneMarked = new Marked();
phoneMarked.use(math);
phoneMarked.use(tilde);
phoneMarked.use(localImageAsText);
// Item 770: a ```html page block is a page, drawn where it stands (replyPages.ts mounts it).
phoneMarked.use(replyPage);
// Item 821: a ```mermaid or ```svg block is a diagram (diagrams.ts draws it).
phoneMarked.use(diagramBlock);
// Item 798: the placeholder (the phone shows the block's path; the Mac draws the table).
phoneMarked.use(evidenceBlock);

/** Render assistant markdown to sanitized HTML. `breaks` keeps a single
 *  newline as a line break (the phone's replies, nightshift 300 A32: a
 *  list of numbers one per line ran together as one paragraph); the
 *  desktop's callers leave it off and render exactly as before. */
export function renderMarkdown(src: string, opts: { breaks?: boolean; localImagesAsText?: boolean } = {}): string {
  // Item 820: the phone's replies draw a local image's picture under the text.
  const html = (opts.localImagesAsText ? phoneMarked : marked).parse(src, markdownOptions(opts)) as string;
  return DOMPurify.sanitize(html, SANITIZE);
}

/**
 * A reply's text (nightshift backlog 213): `renderMarkdown` plus the
 * citation chips and the folded sources list (`cite.ts`). Its own marked
 * instance, so a note, a blocker or a file view that happens to hold a
 * "Sources" list or a `[1](url)` link renders exactly as before.
 */
const replyMarked = new Marked();
replyMarked.use(math);
replyMarked.use(tilde);
// Item 670: in a reply, bold, italics and strikethrough stay on one line.
replyMarked.use(emphasisLines);
replyMarked.use(cite);
// Item 463: a fenced prompt (a hand-off's `start-prompt`, a ```text paragraph) wraps.
replyMarked.use(proseBlocks);
// Item 464: a `<handoff>` block shows as the next chat's prompt card.
replyMarked.use(handoffTag);
// Item 753: an `<ask>` block shows as the turn's question box.
replyMarked.use(askTag);
// Item 820: a local image is its alt text; the picture is drawn under the reply.
replyMarked.use(localImageAsText);
// Item 503: a real shell fence is told apart from raw HTML shaped like one.
const plainBlock = new Renderer();
replyMarked.use({
  renderer: {
    code(token: Tokens.Code) {
      return isRunFence(token) ? markRunFence(plainBlock.code(token)) : false;
    },
  },
});
// Item 770: a ```html page block is a page, drawn where it stands (replyPages.ts mounts it).
replyMarked.use(replyPage);
// Item 821: a ```mermaid or ```svg block is a diagram (diagrams.ts draws it).
replyMarked.use(diagramBlock);
// Item 798: an ```evidence block is a checked evidence table (evidenceTables.ts draws it from its file).
replyMarked.use(evidenceBlock);

export function renderReply(src: string): string {
  // Item 454: a tab switch remounts the whole transcript, and every reply
  // went through marked, KaTeX and DOMPurify again — a maths chat paid the
  // full typesetting on every visit. The output is a pure function of the
  // text (the instance's extensions are fixed at load), so it is kept.
  const hit = replyCache.get(src);
  if (hit !== undefined) {
    // Most recently used last, so the trim drops the oldest.
    replyCache.delete(src);
    replyCache.set(src, hit);
    return hit;
  }
  const html = DOMPurify.sanitize(replyMarked.parse(src, { async: false, gfm: true }), SANITIZE);
  keepReply(src, html);
  return html;
}

/**
 * The rendered replies, by their text (item 454): least recently used
 * first, trimmed past `REPLY_CACHE_CHARS` of source + output. A streaming
 * reply's every intermediate text is a new key, so the cap is what keeps
 * a long turn from growing it without bound; the settled reply is the one
 * a later visit asks for.
 */
const replyCache = new Map<string, string>();
let replyCacheChars = 0;
export const REPLY_CACHE_CHARS = 24_000_000;
function keepReply(src: string, html: string): void {
  const size = src.length + html.length;
  if (size > REPLY_CACHE_CHARS / 4) return;
  replyCache.set(src, html);
  replyCacheChars += size;
  for (const [k, v] of replyCache) {
    if (replyCacheChars <= REPLY_CACHE_CHARS) break;
    replyCache.delete(k);
    replyCacheChars -= k.length + v.length;
  }
}

/** The cache's size, for the tests. */
export function replyCacheStats(): { entries: number; chars: number } {
  return { entries: replyCache.size, chars: replyCacheChars };
}

/**
 * One formula as sanitized HTML — the formatted note editor's math widget
 * (nightshift backlog 150), through the same KaTeX call and the same
 * sanitizer as a formula inside `renderMarkdown`.
 */
export function renderMathHtml(tex: string, display: boolean): string {
  return DOMPurify.sanitize(renderMath(tex, display), SANITIZE);
}

/**
 * Item 626: a streaming reply's unfinished tail, made to render as it will once finished. Marked draws an unclosed
 * `**bold` with its asterisks, a half-typed link with its URL (`[last report](https://exa`) and a table's header row as
 * a paragraph of pipes — then, when the markup closes, the text before it changes under his eyes ("formatted off …
 * the second the turn ends … the formatting fixes"). Only the reply's last line is touched, never inside an open
 * code fence: a half-typed link shows its text alone; an open `code` span and `**` are closed (or dropped when
 * nothing follows them yet); a trailing table that has no complete separator row yet is held back a line or two.
 * The settled reply never goes through this.
 */
export function streamingTail(whole: string): string {
  const fences = whole.match(/^ {0,3}(```|~~~)/gm);
  if (fences && fences.length % 2 === 1) return whole;
  // Item 837 (his 836): a formula that has opened and not closed yet is held back whole — `$\frac{x-1}{\` showed as
  // those raw characters until its `$` arrived. It appears typeset, in one step, when it closes (`openMathAt`).
  const open = openMathAt(whole);
  const src = open < 0 ? whole : whole.slice(0, open);
  // A table still being typed: its header (and half a separator) wait for the separator row.
  const lines = src.split("\n");
  let k = lines.length;
  while (k > 0 && /^\s*\|/.test(lines[k - 1])) k--;
  if (k < lines.length) {
    const block = lines.slice(k);
    const sep = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
    // Cells by the pipes that are not escaped (`\|` is a cell's own bar, as in `$P(A \| B)$`).
    const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).length;
    // Item 837: a table renders row-complete. A body row still arriving — its line not ended, and not yet as many
    // cells as the header with its closing pipe — waits; before, a row grew cell by cell, its last cell half a word.
    const table = block.length >= 2 && sep.test(block[1]) && cells(block[1]) === cells(block[0]);
    if (table && block.length >= 3 && !src.endsWith("\n")) {
      const last = block[block.length - 1];
      const done = open < 0 && /(?<!\\)\|\s*$/.test(last) && cells(last) >= cells(block[0]);
      if (!done) return lines.slice(0, -1).join("\n") + "\n";
    }
    const ready = table && (block.length >= 3 || src.endsWith("\n"));
    if (!ready) return lines.slice(0, k).join("\n");
  }
  const cut = src.lastIndexOf("\n") + 1;
  let line = src.slice(cut);
  // A link whose URL is still arriving: its text, no brackets, no URL.
  line = line.replace(/!?\[([^\]\n]*)\]\([^)\s]*$/, "$1");
  // Code spans: an odd backtick opens one that is still arriving.
  const ticks = line.split("`");
  if (ticks.length % 2 === 0) {
    if (!/\S/.test(ticks[ticks.length - 1])) line = line.replace(/`\s*$/, "");
    else line += "`";
  }
  // Bold and italics outside the code spans (item 636: `*`, `_` and `__` as well as `**`).
  return src.slice(0, cut) + closeEmphasis(line);
}

const isSpace = (ch: string) => /\s/.test(ch);
const isWordChar = (ch: string) => /[\p{L}\p{N}]/u.test(ch);

/**
 * Item 636: a streaming last line's emphasis, as it will render once finished. Before, only `**` was handled, so
 * "night, and *" — the first star of `**the short version**` — drew a lone `*` for a delta. Runs of `*` or `_`
 * outside code spans are paired left to right roughly as CommonMark does (a run opens when a non-space follows it,
 * closes when a non-space precedes it; `_` never inside a word). A run with nothing but space after it that closed
 * nothing is held back, as is half a closer (`**bold*`); an opener still open at the end is closed, before any
 * trailing space so the closer still touches the word. An opener inside a word (`2*3`) is never closed: it may be
 * arithmetic. A bullet (`* `), a rule (`***`, `_ _ _`) and an escaped `\*` are left alone.
 */
function closeEmphasis(line: string): string {
  if (/^\s*([*_-])(\s*\1){2,}\s*$/.test(line)) return line;
  const stack: { c: string; n: number; intra: boolean }[] = [];
  let code = false;
  let hold = -1;
  for (let i = 0; i < line.length; ) {
    const c = line[i];
    if (c === "\\" && !code) {
      i += 2;
      continue;
    }
    if (c === "`") code = !code;
    if (code || (c !== "*" && c !== "_")) {
      i++;
      continue;
    }
    let j = i;
    while (line[j] === c) j++;
    const prev = line[i - 1] ?? " ";
    const next = line[j] ?? " ";
    const atEnd = !/\S/.test(line.slice(j));
    const canOpen = !isSpace(next) && (c === "*" || !isWordChar(prev));
    const canClose = !isSpace(prev) && (c === "*" || !isWordChar(next));
    let n = j - i;
    let closed = false;
    let partial = false;
    if (canClose) {
      while (n > 0) {
        let k = stack.length - 1;
        while (k >= 0 && stack[k].c !== c) k--;
        if (k < 0) break;
        if (stack[k].n > n) {
          partial = atEnd;
          break;
        }
        n -= stack[k].n;
        stack.splice(k);
        closed = true;
      }
    }
    const bullet = c === "*" && n === 1 && /^[\s>]*$/.test(line.slice(0, i)) && isSpace(next) && j < line.length;
    if (partial || (atEnd && !closed && !bullet)) {
      hold = i;
      break;
    }
    if (canOpen) {
      for (; n >= 2; n -= 2) stack.push({ c, n: 2, intra: isWordChar(prev) });
      if (n === 1) stack.push({ c, n: 1, intra: isWordChar(prev) });
    }
    i = j;
  }
  if (hold >= 0) line = line.slice(0, hold);
  const closers = stack
    .filter((o) => !o.intra)
    .reverse()
    .map((o) => o.c.repeat(o.n))
    .join("");
  if (!closers) return line;
  const ws = /\s*$/.exec(line)!;
  return line.slice(0, ws.index) + closers + ws[0];
}
