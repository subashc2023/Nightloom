/**
 * A page inside a reply (nightshift item 770): a fenced block opened with
 *
 *     ```html page A title, if it wants one
 *
 * is drawn where it stands as a card holding the page, in the sandbox of
 * `htmlPage.ts` (no network, nothing of the app), with the kit of
 * `pageKit.ts` loadable by name. A plain ```html block stays code: a
 * snippet shown to be read is never run.
 *
 * The pure half. marked's renderer leaves a placeholder that carries the
 * page's source in an attribute (inert through DOMPurify, and the same
 * through `renderReply`'s cache, a reload and a rewind — it is the reply's
 * own text); `replyPages.ts` mounts `ReplyPage.svelte` into it.
 *
 * A fence still open (the reply is streaming, or was cut off inside it) is
 * not a page yet: it shows as a short code box, capped at a few lines,
 * and becomes the card when its closing fence arrives.
 */
import type { Tokens } from "marked";
import { textKey } from "./viewState";
import type { KitTheme } from "./pageKit";
import "./replyPage.css";

/** The class of the placeholder a page is mounted into, and of what the mount adds inside it. */
export const PAGE_CLASS = "md-page";
export const PAGE_MOUNT_CLASS = "md-page-mount";
/** The class of the box an open page fence shows as. */
export const PAGE_WRITING_CLASS = "md-page-writing";

const escapeHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A fence's info string as a page's: `html page`, then an optional title. Null for any other fence. */
export function pageFence(lang: string | undefined): { title: string } | null {
  const m = /^html?\s+page(?:\s+(.*))?$/i.exec((lang ?? "").trim());
  return m ? { title: (m[1] ?? "").trim().slice(0, 120) } : null;
}

/** Whether marked's code token ended on its closing fence (an open one runs to the end of the text). */
export function fenceClosed(raw: string): boolean {
  const open = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
  if (!open) return false;
  const lines = raw.replace(/\s+$/, "").split("\n");
  if (lines.length < 2) return false;
  const last = lines[lines.length - 1].trim();
  return last.length >= open[1].length && last === open[1][0].repeat(last.length);
}

/** The title a page shows: the fence's, else the page's own `<title>`, else "Page". */
export function pageTitle(fenceTitle: string, html: string): string {
  if (fenceTitle) return fenceTitle;
  const m = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(html);
  return m ? m[1].trim() || "Page" : "Page";
}

/** marked's extension: a page fence as its placeholder (closed) or its writing box (open). */
export const replyPage = {
  renderer: {
    code(token: Tokens.Code) {
      const page = pageFence(token.lang);
      if (!page) return false;
      if (!fenceClosed(token.raw)) {
        return `<div class="${PAGE_WRITING_CLASS}"><div class="md-page-writing-head">Page — shows when its block is finished</div><pre><code class="language-html">${escapeHtml(token.text)}</code></pre></div>\n`;
      }
      // Percent-encoded: DOMPurify drops an attribute whose value holds `</style`, `</title` or `-->`, which a page does.
      return `<div class="${PAGE_CLASS}" data-page-title="${encodeURIComponent(page.title)}" data-page-src="${encodeURIComponent(token.text)}"></div>\n`;
    },
  },
};

/** What a placeholder holds. */
export function pageOf(el: Element): { title: string; html: string; key: string } | null {
  const src = el.getAttribute("data-page-src");
  if (src === null) return null;
  try {
    const html = decodeURIComponent(src);
    return { title: pageTitle(decodeURIComponent(el.getAttribute("data-page-title") ?? ""), html), html, key: textKey(html) };
  } catch {
    return null;
  }
}

/**
 * What a reply page starts from (before its own markup): the app's colours as CSS variables and a quiet
 * base — transparent ground, the app's ink, system type — at zero specificity (`:where`), so anything the
 * page styles itself wins.
 */
export function pageHead(t: KitTheme): string {
  const vars = `--ink:${t.ink};--dim:${t.dim};--line:${t.line};--paper:${t.paper};--raised:${t.raised};--accent:${t.accent};--signal:${t.signal};` + t.series.map((c, i) => `--series-${i + 1}:${c};`).join("");
  return (
    `<meta charset="utf-8"><style>:root{${vars.replace(/[<>{}]/g, "")}}` +
    `:where(html){background:transparent;color:var(--ink);font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-text-size-adjust:100%}` +
    `:where(body){margin:0;padding:14px 16px}` +
    `:where(h1,h2,h3){line-height:1.25;margin:0 0 .5em}:where(h1){font-size:1.35em}:where(h2){font-size:1.15em}:where(h3){font-size:1em}` +
    `:where(p){margin:0 0 .8em}:where(a){color:var(--accent)}:where(small,figcaption,caption){color:var(--dim)}` +
    `:where(table){border-collapse:collapse;font-size:13px}:where(th,td){padding:5px 10px;border-bottom:1px solid var(--line);text-align:left}:where(th){color:var(--dim);font-weight:500}` +
    `:where(button,select,input){font:inherit;color:var(--ink);background:var(--raised);border:1px solid var(--line);border-radius:6px;padding:4px 10px}` +
    `:where(button){cursor:pointer}:where(input[type=range]){padding:0;accent-color:var(--accent)}` +
    `:where(pre.mermaid){margin:0;background:transparent;border:0;text-align:center}:where(svg){max-width:100%}` +
    `</style>`
  );
}
