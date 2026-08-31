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

/**
 * Everything before a `#heading`, which is not part of the note's name.
 *
 * Mirrors `Link::note_target`, guard included: a target that is *only* an
 * anchor is kept whole, because it is what the user typed and the UI shows it.
 * Resolution normalizes separately and more harshly — see `normalizeTarget`.
 */
export function noteTarget(target: string): string {
  const cut = target.indexOf("#");
  return cut > 0 ? target.slice(0, cut) : target;
}

/**
 * A target reduced to the path it names — `knowledge::normalize_target`.
 *
 * Deliberately *not* `noteTarget`: the resolver's `#` split is unguarded, so
 * `[[#todo]]` normalizes to nothing and is missing even in a vault that holds
 * a note called `#todo.md`. The `./` strip takes every repetition, as
 * `trim_start_matches` does, not the first.
 */
function normalizeTarget(target: string): string {
  const t = target.replace(/\\/g, "/");
  const cut = t.indexOf("#");
  return (cut < 0 ? t : t.slice(0, cut))
    .trim()
    .replace(/^(?:\.\/)+/, "")
    .replace(/^\/+|\/+$/g, "");
}

/**
 * ASCII case folding — `str::eq_ignore_ascii_case`, which is what the backend
 * compares names with. `toLowerCase()` folds the whole of Unicode, which would
 * resolve `[[café]]` to `CAFÉ.md` in this editor and nowhere else.
 */
function fold(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * What a target turned out to name — `knowledge::Resolution`, carrying notes
 * where the backend carries indexes into its own list.
 *
 * Ambiguity is a state of its own rather than a flavour of missing, because
 * the two want opposite things said to the user: one note has to be written,
 * or one of several has to be named.
 */
export type NoteResolution =
  | { kind: "note"; note: Note }
  | { kind: "ambiguous"; notes: Note[] }
  | { kind: "missing" };

/**
 * Resolve a target against the vault, mirroring `knowledge::resolve_link`.
 *
 * Obsidian's rule: a full relative path if it matches, otherwise a unique
 * basename anywhere in the vault, with the extension optional on both. A
 * basename shared by two notes is reported rather than picked — choosing one
 * silently would make a link mean different things as the vault grows.
 */
export function resolveLink(target: string, notes: Note[]): NoteResolution {
  const wanted = fold(normalizeTarget(target));
  if (!wanted) return { kind: "missing" };
  const withMd = `${wanted}.md`;
  const exact = notes.find(
    (n) => fold(n.name) === wanted || fold(n.name) === withMd,
  );
  if (exact) return { kind: "note", note: exact };

  const base = wanted.split("/").pop() ?? wanted;
  const matches = notes.filter((n) => fold(stem(n.name)) === base);
  if (matches.length === 1) return { kind: "note", note: matches[0] };
  return matches.length === 0
    ? { kind: "missing" }
    : { kind: "ambiguous", notes: matches };
}

/** The one note a target names, or null when it names none or several. */
export function resolveNote(target: string, notes: Note[]): Note | null {
  const found = resolveLink(target, notes);
  return found.kind === "note" ? found.note : null;
}

/**
 * What a link's hover says about where it points.
 *
 * One function rather than a sentence per surface, because a link is offered in
 * three places — the rendered preview, the outbound strip, the graph — and a
 * vault where each of them describes ambiguity differently is one where the
 * reader has to work out that they are the same condition. Ambiguity gets its
 * own sentence: "no such note yet" would be a lie the user cannot act on, since
 * the note exists twice and the fix is to say which one, not to write it.
 */
export function linkTitle(target: string, found: NoteResolution): string {
  switch (found.kind) {
    case "note":
      return found.note.name;
    case "ambiguous":
      return `${target} — more than one note has that name (${found.notes
        .map((n) => n.name)
        .join(", ")}); link one by its path`;
    default:
      return `${target} — no such note yet`;
  }
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
    const found = resolveLink(target, vault);
    const label = escapeHtml(token.text);
    // A broken link is styled, not hidden or dropped: writing `[[thing]]`
    // before the note exists is how a note gets planned, so this is a state
    // to show rather than an error.
    const cls = found.kind === "note" ? "wikilink" : "wikilink broken";
    const title = linkTitle(target, found);
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
