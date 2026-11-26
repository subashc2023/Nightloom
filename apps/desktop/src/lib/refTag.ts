/*
 * Typed links (nightshift item 993a, 2026-11-26): a reply names an event, an
 * email or a doc inside one tag, on one line, attribute values in double
 * quotes, the text inside the name shown —
 *
 *     <event id="EVENT_ID" src="Calendar 974e51a6" start="2026-11-25T12:00-08:00" rsvp="needsAction">COAST Meeting</event>
 *     <email id="MESSAGE_ID" src="Gmail 2117773e" from="Priya S." gist="…">Speaker confirmation for Dec 4</email>
 *     <doc id="FILE_ID" src="Google Drive b7e1394d" type="doc" owner="Priya S.">Run of show</doc>
 *
 * (`REF_ATTRS` is the whole grammar; `id` and `src` are required. The fields
 * are what the connector returned when the model read the item — blocker
 * 2306 — and the card, `RefCard.svelte`, shows what is present.)
 *
 * Every reply surface draws the tag as `<a class="nl-ref" data-ref-kind
 * data-ref-*>name</a>` — no `href`, so the link router never sees it; the
 * card's delegate (`RefCardHost.svelte`) opens on a click. The same rules as
 * the other tags: read by the tokenizer, so a tag in a code fence or inline
 * code is text; a tag without `id` or `src`, or with nothing inside, is its
 * name drawn plain; a half tag at the end of a streaming reply is held back
 * until it closes (`openRefAt`, as `openMathAt` does for a formula).
 *
 * Nothing in a tag is trusted: every value is escaped; `link` is kept only
 * when it is https on one of Google's own hosts (`refLink`); and the card
 * reads a link back through `refFromEl`, which checks all of it again — a
 * reply can also write the `<a>` itself as raw HTML.
 *
 * Plain-text places (a chat's name, a search snippet, an aside's label, a
 * question card, Copy, Listen) show the name alone: `refPlain`.
 */
import type { MarkedExtension, Tokens } from "marked";
import "./refTag.css";

export type RefKind = "event" | "email" | "doc";
export const REF_KINDS: readonly RefKind[] = ["event", "email", "doc"];

/** The attributes each kind may carry; anything else in a tag is dropped. */
export const REF_ATTRS: Record<RefKind, readonly string[]> = {
  event: ["id", "src", "cal", "start", "end", "rsvp", "where", "organizer", "guests", "repeats", "link", "asof"],
  email: ["id", "src", "thread", "from", "to", "at", "gist", "count", "link", "asof"],
  // A doc's `type` is doc | sheet | slides | pdf | file; a tag may also write it `kind` (read as `type`).
  doc: ["id", "src", "type", "owner", "edited", "editor", "access", "shared", "link", "asof"],
};

export interface Ref {
  kind: RefKind;
  /** The words between the tags. */
  name: string;
  /** The connector's own id for the item (`eventId`, `messageId`, `fileId`). */
  id: string;
  /** Claude Code's name for the connector it came from ("Calendar 974e51a6"). */
  src: string;
  /** Every other attribute that was present and allowed, by name. */
  fields: Record<string, string>;
}

/** The longest a value or a name is kept (a tag is one line of a reply, not a page). */
export const REF_VALUE_MAX = 600;

const KINDS = "event|email|doc";
const ATTR = String.raw`\s+[a-z][a-z0-9-]*="[^"\n]*"`;
const TAG_AT = new RegExp(String.raw`^<(${KINDS})((?:${ATTR})*)\s*>([^<\n]*)</\1>`);
const TAG_ALL = new RegExp(String.raw`<(${KINDS})(?:${ATTR})*\s*>([^<\n]*)</\1>`, "g");
const OPENER = new RegExp(String.raw`<(${KINDS})(?=[\s>])`, "g");
const START = new RegExp(String.raw`<(?:${KINDS})[\s>]`);
/** `<`, `<ev`, `<email` … at the very end: an opener still arriving. */
const HALF_OPENER = /<(?:e(?:v(?:e(?:nt?)?)?)?|e(?:m(?:a(?:il?)?)?)?|d(?:oc?)?)?$/;
const ONE_ATTR = /([a-z][a-z0-9-]*)="([^"\n]*)"/g;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A value as written in a tag, read: the five entities a model escapes a quote or a bracket with. */
function unescape(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const clean = (s: string) => unescape(s).replace(/\s+/g, " ").trim().slice(0, REF_VALUE_MAX);

/** Hosts an item's own page may be on; Calendar's event pages are `www.google.com/calendar/…`. */
const LINK_HOSTS = ["calendar.google.com", "mail.google.com", "docs.google.com", "drive.google.com"];

/** The item's link when it is https on one of Google's own hosts, else null (never drawn, never opened). */
export function refLink(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
    if (LINK_HOSTS.includes(u.hostname)) return u.href;
    if (u.hostname === "www.google.com" && u.pathname.startsWith("/calendar/")) return u.href;
    return null;
  } catch {
    return null;
  }
}

/** A tag's parts as a link, or null when it may not be one (no id, no source, no name). */
export function makeRef(kind: string, attrs: Record<string, string>, name: string): Ref | null {
  if (!REF_KINDS.includes(kind as RefKind)) return null;
  const k = kind as RefKind;
  const id = clean(attrs.id ?? "");
  const src = clean(attrs.src ?? "");
  const shown = clean(name);
  if (!id || !src || !shown) return null;
  const fields: Record<string, string> = {};
  if (k === "doc" && attrs.kind && !attrs.type) attrs = { ...attrs, type: attrs.kind };
  for (const a of REF_ATTRS[k]) {
    if (a === "id" || a === "src" || !(a in attrs)) continue;
    const v = a === "link" ? (refLink(unescape(attrs[a])) ?? "") : clean(attrs[a]);
    if (v) fields[a] = v;
  }
  return { kind: k, name: shown, id, src, fields };
}

function attrsOf(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  // The first of a repeated attribute wins, as in HTML.
  for (const m of text.matchAll(ONE_ATTR)) if (!(m[1] in out)) out[m[1]] = m[2];
  return out;
}

/** One whole tag (nothing before or after it) as a link; null when it is not a well-formed, complete one. */
export function parseRef(tag: string): Ref | null {
  const m = TAG_AT.exec(tag);
  return m && m[0].length === tag.length ? makeRef(m[1], attrsOf(m[2]), m[3]) : null;
}

/** The link's HTML. */
export function refHtml(r: Ref): string {
  let data = ` data-ref-kind="${r.kind}" data-ref-id="${escapeHtml(r.id)}" data-ref-src="${escapeHtml(r.src)}"`;
  for (const [k, v] of Object.entries(r.fields)) data += ` data-ref-${k}="${escapeHtml(v)}"`;
  return `<a class="nl-ref"${data} role="button" tabindex="0">${escapeHtml(r.name)}</a>`;
}

/**
 * The link an element of a reply stands for, read back from its `data-ref-*`
 * and checked again from nothing: the kind, the id and source, each allowed
 * attribute, the link's host. Null for anything else.
 */
export function refFromEl(el: Element | null | undefined): Ref | null {
  if (!el || !el.classList?.contains("nl-ref")) return null;
  const attrs: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) if (a.name.startsWith("data-ref-") && a.name !== "data-ref-kind") attrs[a.name.slice(9)] = a.value;
  return makeRef(el.getAttribute("data-ref-kind") ?? "", attrs, el.textContent ?? "");
}

/** What one item is called across replies and cards: its kind, source and id. */
export function refKey(r: Pick<Ref, "kind" | "src" | "id">): string {
  return `${r.kind}:${r.src}:${r.id}`;
}

interface RefToken extends Tokens.Generic {
  type: "ref";
  raw: string;
  ref: Ref | null;
  name: string;
}

/** The marked extension: a typed tag is its link; one that may not be a link is its name, plain. */
export const refTag: MarkedExtension = {
  extensions: [
    {
      name: "ref",
      level: "inline",
      start(src: string): number | undefined {
        const i = src.search(START);
        return i < 0 ? undefined : i;
      },
      tokenizer(src: string): RefToken | undefined {
        const m = TAG_AT.exec(src);
        if (!m) return undefined;
        return { type: "ref", raw: m[0], ref: makeRef(m[1], attrsOf(m[2]), m[3]), name: clean(m[3]) };
      },
      renderer(token: Tokens.Generic): string {
        const t = token as RefToken;
        return t.ref ? refHtml(t.ref) : escapeHtml(t.name);
      },
    },
  ],
};

/**
 * Where a typed tag that has opened and not yet closed starts in a streaming
 * reply's last line, or -1: the line is drawn up to there, so `<event id="…`
 * never shows as those characters. An opener inside an open inline-code span
 * is text and is left alone.
 */
export function openRefAt(line: string): number {
  let at = -1;
  for (const m of line.matchAll(OPENER)) {
    const i = m.index ?? 0;
    if (!line.slice(i).includes(`</${m[1]}>`)) {
      at = i;
      break;
    }
  }
  if (at < 0) {
    const h = HALF_OPENER.exec(line);
    if (h) at = h.index;
  }
  if (at < 0) return -1;
  const ticks = line.slice(0, at).split("`").length - 1;
  return ticks % 2 === 1 ? -1 : at;
}

const stripLine = (l: string) => l.replace(TAG_ALL, (_, _k: string, name: string) => clean(name));

/**
 * Text for a place that cannot draw a link: every typed tag is its name.
 * Code keeps its characters — a fenced block and an inline code span are
 * left exactly as written.
 */
export function refPlain(text: string): string {
  if (!text || !START.test(text)) return text;
  let fence = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fence = !fence;
        return line;
      }
      if (fence) return line;
      if (!line.includes("`")) return stripLine(line);
      const parts = line.split("`");
      // Balanced backticks: the odd pieces are code. Unbalanced: nothing is.
      if (parts.length % 2 === 0) return stripLine(line);
      return parts.map((p, i) => (i % 2 === 1 ? p : stripLine(p))).join("`");
    })
    .join("\n");
}

/**
 * A piece of a message cut anywhere (a search snippet either side of its
 * hit): whole tags are their names, and the cut-off halves go — a closing
 * tag, an opener missing its end, the tail of an opener at the piece's start.
 */
export function refPlainFragment(s: string): string {
  if (!s || !/[<>]/.test(s)) return s;
  return stripLine(s)
    .replace(new RegExp(String.raw`^[^<>]*">(?=[^<>]*</(?:${KINDS})>)`), "")
    .replace(new RegExp(String.raw`</(?:${KINDS})>`, "g"), "")
    .replace(new RegExp(String.raw`<(?:${KINDS})(?:\s[^<>]*)?>`, "g"), "")
    .replace(new RegExp(String.raw`<(?:${KINDS})\s[^<>]*$`), "")
    .replace(/<(?:e(?:v(?:e(?:nt?)?)?)?|em(?:a(?:il?)?)?|d(?:oc?)?)$/, "");
}
