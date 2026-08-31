import { Marked } from "marked";
import type { MarkedExtension, TokenizerAndRendererExtension } from "marked";
import DOMPurify from "dompurify";
import { math } from "./math";
import type { Note } from "./types";

/**
 * `[[wikilinks]]` in a knowledge note.
 *
 * Recognition happens in marked's *tokenizer* rather than as a pass over the
 * rendered HTML, for the reason `math.ts` gives at length: by the time
 * markdown has been parsed the delimiters may have survived but the thing
 * between them has not. It also gets code-span exclusion for free — marked
 * consumes the source left to right, so a `` `[[x]]` `` is claimed whole by
 * the built-in codespan tokenizer at the backtick and this extension is never
 * asked about the brackets inside it. A fenced block never reaches inline
 * tokenizing at all.
 *
 * **This file resolves links for presentation only.** The authority is
 * `knowledge.rs`, whose parse and resolution are what the graph and therefore
 * the model see. This is the third projection that has to stay in step with
 * the backend (with `liveFlags` and `currentTodos`), and the reason it exists
 * rather than calling the backend is that the editor renders text that has
 * not been saved yet — there is no file to ask about.
 */

/** Target and alias of one link, as written. */
export interface ParsedLink {
  target: string;
  alias: string | null;
}

/** Everything before a `#heading`, which is not part of the note's name. */
export function noteTarget(target: string): string {
  const cut = target.indexOf("#");
  return cut > 0 ? target.slice(0, cut) : target;
}

/**
 * The note a target names, or null.
 *
 * Obsidian's rule, mirroring `knowledge::resolve_link`: a full relative path
 * if it matches, otherwise a unique basename anywhere in the vault, with the
 * extension optional on both. A basename shared by two notes resolves to
 * nothing rather than to the first — picking one silently would make a link
 * mean different things as the vault grows.
 */
export function resolveNote(target: string, notes: Note[]): Note | null {
  const wanted = noteTarget(target)
    .replace(/\\/g, "/")
    .trim()
    .replace(/^\.\//, "")
    .replace(/^\/+|\/+$/g, "");
  if (!wanted) return null;
  const lower = wanted.toLowerCase();
  const exact = notes.find(
    (n) => n.name.toLowerCase() === lower || n.name.toLowerCase() === `${lower}.md`,
  );
  if (exact) return exact;

  const base = lower.split("/").pop() ?? lower;
  const matches = notes.filter((n) => stem(n.name).toLowerCase() === base);
  return matches.length === 1 ? matches[0] : null;
}

/** `rust/async.md` -> `async` */
function stem(name: string): string {
  const base = name.split("/").pop() ?? name;
  const cut = base.lastIndexOf(".");
  return cut > 0 ? base.slice(0, cut) : base;
}

/**
 * The href a rendered wikilink carries.
 *
 * A fragment rather than a custom scheme, because DOMPurify strips every
 * scheme outside its allow-list and a `nlnote:` href would arrive as a dead
 * anchor with no way to tell it apart from a real one. A fragment is allowed
 * as-is, and the click handler reads the target back out of it.
 */
const HREF_PREFIX = "#kb:";

export function linkHref(target: string): string {
  return HREF_PREFIX + encodeURIComponent(target);
}

/** The target inside a wikilink href, or null for any other anchor. */
export function hrefTarget(href: string | null): string | null {
  if (!href) return null;
  const at = href.indexOf(HREF_PREFIX);
  if (at < 0) return null;
  try {
    return decodeURIComponent(href.slice(at + HREF_PREFIX.length));
  } catch {
    return null;
  }
}

/**
 * Which notes the renderer resolves against.
 *
 * Module state because a marked extension is registered once and rendering
 * takes only a string. Set immediately before each render; presentation-only,
 * so a stale value costs a link the wrong colour and nothing else.
 */
let vault: Note[] = [];

const wikilink: TokenizerAndRendererExtension = {
  name: "wikilink",
  level: "inline",
  start(src: string) {
    return src.indexOf("[[");
  },
  tokenizer(src: string) {
    // One line, no nested bracket, and a cap: every one of those is what an
    // unterminated `[[` looks like, and leaving it as literal text is the
    // right answer for a note being typed.
    const match = /^\[\[([^\[\]\n]{1,200})\]\]/.exec(src);
    if (!match) return undefined;
    const inner = match[1];
    const bar = inner.indexOf("|");
    const target = (bar < 0 ? inner : inner.slice(0, bar)).trim();
    if (!target) return undefined;
    const alias = bar < 0 ? null : inner.slice(bar + 1).trim() || null;
    return {
      type: "wikilink",
      raw: match[0],
      text: alias ?? target,
      target,
    } as never;
  },
  renderer(token) {
    const target = (token as unknown as { target: string }).target;
    const found = resolveNote(target, vault);
    const label = escapeHtml(token.text);
    // A broken link is styled, not hidden or dropped: writing `[[thing]]`
    // before the note exists is how a note gets planned, so this is a state
    // to show rather than an error.
    const cls = found ? "wikilink" : "wikilink broken";
    const title = found ? found.name : `${target} — no such note yet`;
    return `<a class="${cls}" href="${linkHref(target)}" title="${escapeHtml(title)}">${label}</a>`;
  },
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const wikilinks: MarkedExtension = { extensions: [wikilink] };

/**
 * Its own `Marked` instance rather than `marked.use(wikilinks)`, so the
 * transcript keeps rendering assistant text exactly as it did. A model that
 * happens to write `[[x]]` in a reply should not have it turn into a link to
 * a file the reader has no way to click.
 */
const noteMarked = new Marked();
noteMarked.use(math);
noteMarked.use(wikilinks);

/** Render a note to sanitized HTML, with wikilinks resolved against `notes`. */
export function renderNote(src: string, notes: Note[]): string {
  vault = notes;
  const html = noteMarked.parse(src, { async: false, gfm: true }) as string;
  return DOMPurify.sanitize(html, { ADD_TAGS: ["semantics", "annotation"] });
}

/** Every distinct link target in `src`, in order — used for the outbound list. */
export function parseLinks(src: string): ParsedLink[] {
  const out: ParsedLink[] = [];
  const seen = new Set<string>();
  // Fenced blocks are stripped first; inline code is left, which costs a
  // spurious entry in a list the user can see and correct. The backend's
  // parser is the one the graph is built from and it excludes both.
  const body = src.replace(/^[ \t]*(`{3,}|~{3,})[\s\S]*?^[ \t]*\1[ \t]*$/gm, "");
  for (const match of body.matchAll(/\[\[([^\[\]\n]{1,200})\]\]/g)) {
    const inner = match[1];
    const bar = inner.indexOf("|");
    const target = (bar < 0 ? inner : inner.slice(0, bar)).trim();
    if (!target || seen.has(target)) continue;
    seen.add(target);
    out.push({ target, alias: bar < 0 ? null : inner.slice(bar + 1).trim() || null });
  }
  return out;
}
