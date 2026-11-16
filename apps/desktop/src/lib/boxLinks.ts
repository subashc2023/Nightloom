/**
 * Links in the message box (nightshift item 696, his words 2026-11-15:
 * links in the box "should like become blue or whatever, and hyperlink to
 * the link that they are meant to send to"). A bare URL (`https://…`,
 * `http://…`, `www.…`) and a Markdown `[text](url)` link are found here;
 * both boxes draw them in the theme's link colour — the plain box's layer
 * (`BoxLayer.svelte`) and the formatted box (`composerEditor.ts`, a `link`
 * span) — and ⌘-click opens one by the app's own route (`routeLink`,
 * `webtabs.svelte.ts`: the browser or a web tab, by the Settings row), so
 * a plain click still places the caret (blocker 1994, his call).
 *
 * Nothing inside inline code or a code fence is a link: `curl https://…`
 * in backticks is code he is sending, not somewhere to go. Pure over the
 * text, so the suite pins it (`boxLinks696.test.ts`).
 */
import { findFences } from "./codeDetect";

export interface BoxLink {
  /** Where the link's text sits in the box: a bare URL, or the whole `[text](url)`. */
  from: number;
  to: number;
  /** Where it opens: an absolute http(s) or mailto URL. */
  href: string;
}

/** Characters a bare URL may end on in prose but never means to. */
const TRAILING = /[.,;:!?'"…*_~]$/;

/** The stretches of `text` that are code: fenced blocks (to their closing
 *  line, or the end when unclosed) and inline code spans. */
function codeRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  const lines = text.split("\n");
  const starts: number[] = [];
  let off = 0;
  for (const l of lines) {
    starts.push(off);
    off += l.length + 1;
  }
  const fences = findFences(text).map((f): [number, number] => [
    f.start,
    f.close === null ? text.length : starts[f.close] + lines[f.close].length,
  ]);
  out.push(...fences);
  // Inline code: a run of n backticks closed by the next run of exactly n
  // (CommonMark); a run with no closer is literal backticks.
  let i = 0;
  while (i < text.length) {
    const fence = fences.find(([a, b]) => i >= a && i < b);
    if (fence) {
      i = fence[1];
      continue;
    }
    if (text[i] !== "`") {
      i++;
      continue;
    }
    let n = 0;
    while (text[i + n] === "`") n++;
    const limit = fences.find(([a]) => a > i)?.[0] ?? text.length;
    let j = i + n;
    let close = -1;
    while (j < limit) {
      if (text[j] !== "`") {
        j++;
        continue;
      }
      let m = 0;
      while (text[j + m] === "`") m++;
      if (m === n) {
        close = j;
        break;
      }
      j += m;
    }
    if (close >= 0 && close + n <= limit) {
      out.push([i, close + n]);
      i = close + n;
    } else {
      i += n;
    }
  }
  return out;
}

/** The URL a link's target opens, or null when it is not one to open:
 *  http(s) with a host, mailto with an address, or `www.` (over https). */
function openable(target: string): string | null {
  let url = target;
  if (/^www\.[^.\s/]/i.test(url)) url = "https://" + url;
  if (!/^(https?:\/\/[^\s/?#.][^\s]*|mailto:[^\s@]+@[^\s]+)$/i.test(url)) return null;
  try {
    new URL(url);
    return url;
  } catch {
    return null;
  }
}

/** A Markdown link's target from just after its `(`: up to the `)` that
 *  closes it, parentheses inside balanced; null without a closer. */
function mdTarget(text: string, at: number): { url: string; end: number } | null {
  let depth = 0;
  for (let k = at; k < text.length; k++) {
    const c = text[k];
    if (/\s/.test(c)) return null;
    if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) return k > at ? { url: text.slice(at, k), end: k + 1 } : null;
      depth--;
    }
  }
  return null;
}

/** A bare URL with what prose put after it taken off: stray punctuation,
 *  and a `)` or `]` it does not itself open. */
function trimBare(url: string): string {
  const count = (s: string, c: string) => s.split(c).length - 1;
  for (;;) {
    if (TRAILING.test(url)) url = url.slice(0, -1);
    else if (url.endsWith(")") && count(url, "(") < count(url, ")")) url = url.slice(0, -1);
    else if (url.endsWith("]") && count(url, "[") < count(url, "]")) url = url.slice(0, -1);
    else if (url.endsWith("}") && count(url, "{") < count(url, "}")) url = url.slice(0, -1);
    else return url;
  }
}

/** Every link in the box's text, in order, none inside code. */
export function findBoxLinks(text: string): BoxLink[] {
  const code = codeRanges(text);
  const inCode = (a: number, b: number) => code.some(([x, y]) => a < y && b > x);
  const out: BoxLink[] = [];

  const md = /\[([^[\]\n]*)\]\(/g;
  for (let m = md.exec(text); m; m = md.exec(text)) {
    const t = mdTarget(text, m.index + m[0].length);
    if (!t) continue;
    const href = openable(t.url);
    if (!href || inCode(m.index, t.end)) continue;
    out.push({ from: m.index, to: t.end, href });
    md.lastIndex = t.end;
  }
  const taken = [...out];
  const overlapsMd = (a: number, b: number) => taken.some((l) => a < l.to && b > l.from);

  const bare = /(?:https?:\/\/|www\.)[^\s<>`]+/gi;
  for (let m = bare.exec(text); m; m = bare.exec(text)) {
    const from = m.index;
    if (from > 0 && /[A-Za-z0-9]/.test(text[from - 1])) continue;
    const url = trimBare(m[0]);
    const to = from + url.length;
    const href = openable(url);
    if (!href || inCode(from, to) || overlapsMd(from, to)) continue;
    out.push({ from, to, href });
  }
  return out.sort((a, b) => a.from - b.from);
}

/** The link under offset `at` (its ends included), or null. */
export function linkAt(links: BoxLink[], at: number): BoxLink | null {
  return links.find((l) => at >= l.from && at <= l.to) ?? null;
}

/** One line's text (`rest`, starting at `start` in the box) cut into plain
 *  pieces and link pieces, which join back to `rest` — the plain box's
 *  layer draws each link piece in the link colour. */
export function lineLinkSegs(rest: string, start: number, links: BoxLink[]): { text: string; href: string | null }[] {
  const end = start + rest.length;
  const out: { text: string; href: string | null }[] = [];
  let at = start;
  for (const l of links) {
    if (l.to <= start || l.from >= end) continue;
    const a = Math.max(l.from, start);
    const b = Math.min(l.to, end);
    if (a > at) out.push({ text: rest.slice(at - start, a - start), href: null });
    out.push({ text: rest.slice(a - start, b - start), href: l.href });
    at = b;
  }
  if (at < end || out.length === 0) out.push({ text: rest.slice(at - start), href: null });
  return out;
}

/** The quiet hint a box shows over a link: how to open it here. */
export function openHint(mac: boolean): string {
  return mac ? "⌘-click to open" : "Ctrl-click to open";
}
