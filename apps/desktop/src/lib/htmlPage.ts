/**
 * An HTML file drawn as a page (nightshift item 819, his "why cant nightloom
 * render html", 2026-11-17), the pure half of `HtmlPage.svelte`; item 770's
 * inline pages in a reply are meant to reuse both.
 *
 * The page is a sandboxed `<iframe srcdoc>`:
 * - `sandbox="allow-scripts"` and nothing else — never `allow-same-origin`,
 *   so the page runs in an opaque origin: it cannot reach the app's DOM,
 *   `window.__TAURI_INTERNALS__`, its storage or its cookies, and without
 *   `allow-top-navigation`, `allow-popups` or `allow-forms` it cannot move
 *   the app, open a window or post a form.
 * - A Content Security Policy written into the document before anything of
 *   the page's: inline styles and scripts (a chart's tooltip code) and
 *   `data:`/`blob:` images and fonts only — no `fetch`, no XHR, no
 *   WebSocket, no remote image, script, style or font, no nested frame.
 * - The app's own pages carry `frame-src 'none'` (index.html, remote.html),
 *   which every navigation of a child frame is checked against — so the page
 *   cannot leave its `srcdoc` for a URL or a `data:` document (one that would
 *   not carry the policy above) either.
 * - A small bridge script, first in the document, tells the app where the
 *   page is scrolled (kept per tab) and what the policy blocked, takes a
 *   scroll to restore, and keeps a link click from navigating. It talks by
 *   `postMessage` only; the app reads nothing else from the frame.
 */

/** The iframe's `sandbox` value. A test pins it: never `allow-same-origin`. */
export const HTML_SANDBOX = "allow-scripts";

/** The policy written into every page (see the header). */
export const HTML_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** The tag every message from the bridge carries, so the app can tell its
 *  own messages from anything else a page posts. */
export const BRIDGE_TAG = "nightloom-html-819";

export type Scheme = "light" | "dark";

/** What the bridge posts to the app. */
export type BridgeMessage =
  | { tag: typeof BRIDGE_TAG; kind: "scroll"; x: number; y: number }
  | { tag: typeof BRIDGE_TAG; kind: "blocked"; uri: string }
  | { tag: typeof BRIDGE_TAG; kind: "link"; href: string };

/** The bridge, as source. Runs inside the sandbox; the app's only channel. */
const BRIDGE = `(function () {
  var T = ${JSON.stringify(BRIDGE_TAG)};
  var post = function (m) { m.tag = T; try { parent.postMessage(m, "*"); } catch (e) {} };
  var want = null, held = false, timer = 0;
  var place = function () {
    if (!want || held) return;
    var el = document.scrollingElement || document.documentElement;
    if (!el) return;
    window.scrollTo(want.x, want.y);
    if (el.scrollHeight - el.clientHeight >= want.y - 1) want = null;
  };
  addEventListener("message", function (e) {
    var d = e.data;
    if (e.source !== parent || !d || d.tag !== T || d.kind !== "restore") return;
    want = { x: +d.x || 0, y: +d.y || 0 };
    place(); setTimeout(place, 150); setTimeout(place, 600);
  });
  ["wheel", "keydown", "mousedown", "touchstart"].forEach(function (t) {
    addEventListener(t, function () { held = true; }, true);
  });
  addEventListener("scroll", function () {
    if (timer) return;
    timer = setTimeout(function () {
      timer = 0;
      post({ kind: "scroll", x: Math.round(scrollX), y: Math.round(scrollY) });
    }, 120);
  }, true);
  document.addEventListener("securitypolicyviolation", function (e) {
    post({ kind: "blocked", uri: String(e.blockedURI || e.violatedDirective || "") });
  });
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    var h = a.getAttribute("href") || "";
    if (h.charAt(0) === "#") return;
    e.preventDefault();
    post({ kind: "link", href: String(a.href || h) });
  }, true);
})();`;

/** The head written before the page's own markup. */
function preamble(scheme: Scheme): string {
  return (
    `<meta http-equiv="Content-Security-Policy" content="${HTML_CSP}">` +
    `<meta name="color-scheme" content="${scheme}">` +
    `<script>${BRIDGE}</script>`
  );
}

/** Where the preamble goes: after a leading BOM, whitespace, comments and
 *  the doctype — before it would put the page in quirks mode — and before
 *  anything else, so the policy binds the page's first script. */
export function preambleAt(html: string): number {
  const re = /^(?:﻿|\s+|<!--[\s\S]*?-->)*(?:<!doctype[^>]*>)?/i;
  const m = re.exec(html);
  return m ? m[0].length : 0;
}

/** The `srcdoc` for a file's text. */
export function pageDocument(html: string, scheme: Scheme): string {
  const at = preambleAt(html);
  return html.slice(0, at) + preamble(scheme) + html.slice(at);
}

/** A message from the bridge, or null for anything else a page posts. */
export function bridgeMessage(data: unknown): BridgeMessage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.tag !== BRIDGE_TAG) return null;
  if (d.kind === "scroll" && typeof d.x === "number" && typeof d.y === "number" && isFinite(d.x) && isFinite(d.y))
    return { tag: BRIDGE_TAG, kind: "scroll", x: Math.max(0, d.x), y: Math.max(0, d.y) };
  if (d.kind === "blocked" && typeof d.uri === "string") return { tag: BRIDGE_TAG, kind: "blocked", uri: d.uri.slice(0, 300) };
  if (d.kind === "link" && typeof d.href === "string") return { tag: BRIDGE_TAG, kind: "link", href: d.href.slice(0, 300) };
  return null;
}

/** Whether a path is drawn as a page. */
export function isHtmlPath(path: string): boolean {
  return /\.html?$/i.test(path);
}

/** Where each page was scrolled, by the key its view gives (a file's path,
 *  a note's scope and name). In memory only, as `tabPlace.ts` keeps a tab's
 *  scroll: pixels of a layout a relaunch redoes. */
const places = new Map<string, { x: number; y: number }>();
const MAX_PLACES = 200;
export function pagePlace(key: string): { x: number; y: number } | null {
  return places.get(key) ?? null;
}
export function setPagePlace(key: string, x: number, y: number): void {
  places.delete(key);
  places.set(key, { x, y });
  while (places.size > MAX_PLACES) places.delete(places.keys().next().value!);
}
