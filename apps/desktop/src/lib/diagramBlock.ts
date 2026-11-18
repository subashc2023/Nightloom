/**
 * Diagram blocks in markdown (nightshift item 821, via 818 §4 P4): a fenced
 *
 *     ```mermaid        — drawn as the diagram (Mermaid, from 770's kit)
 *     ```svg            — drawn as a picture, sanitised, through an <img>
 *
 * in every markdown surface (replies in both looks, asides, notes, markdown
 * file tabs, the phone), with a Diagram / Source toggle kept per block.
 *
 * The pure half. marked's renderer draws a closed fence as a placeholder
 * that holds the block's source twice: in an attribute (what the drawing
 * is made from) and as the ordinary code block inside it — so a surface
 * that never draws it, a block that fails, and the Source view all show
 * the same thing, never a blank. `diagrams.ts` adds the drawing beside it.
 * A fence still open (a reply streaming, or cut off inside it) is left to
 * marked: a plain code block until its closing fence arrives.
 *
 * An SVG is never put into the app's document. It is sanitised (DOMPurify's
 * SVG profile: no script, no `on…` handler, no `<foreignObject>`) and then
 * shown as an `<img>` from a `data:` URL, where nothing in it runs and
 * nothing outside it loads even if the sanitiser missed something.
 */
import type { Tokens } from "marked";
import DOMPurify from "dompurify";
import { textKey } from "./viewState";
import { fenceClosed } from "./replyPage";

export type DiagramKind = "mermaid" | "svg";

/** The placeholder's class, and the class of the drawing `diagrams.ts` puts first inside it. */
export const DIAGRAM_CLASS = "md-diagram";
export const DIAGRAM_MOUNT_CLASS = "md-diagram-mount";

const escapeHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A fence's info string as a diagram's kind; null for any other fence. Only the first word counts. */
export function diagramFence(lang: string | undefined): DiagramKind | null {
  const w = (lang ?? "").trim().split(/\s+/)[0].toLowerCase();
  if (w === "mermaid" || w === "mmd") return "mermaid";
  if (w === "svg") return "svg";
  return null;
}

/** marked's extension: a closed diagram fence as its placeholder (with its code block inside). */
export const diagramBlock = {
  renderer: {
    code(token: Tokens.Code) {
      const kind = diagramFence(token.lang);
      if (!kind || !fenceClosed(token.raw)) return false;
      // Percent-encoded: DOMPurify drops an attribute whose value holds `</style`, `</title` or `-->`.
      return (
        `<div class="${DIAGRAM_CLASS}" data-diagram="${kind}" data-diagram-src="${encodeURIComponent(token.text)}">` +
        `<pre><code class="language-${kind}">${escapeHtml(token.text)}</code></pre></div>\n`
      );
    },
  },
};

/** What a placeholder holds. */
export function diagramOf(el: Element): { kind: DiagramKind; src: string; key: string } | null {
  const kind = diagramFence(el.getAttribute("data-diagram") ?? "");
  const raw = el.getAttribute("data-diagram-src");
  if (!kind || raw === null) return null;
  try {
    const src = decodeURIComponent(raw);
    return { kind, src, key: textKey(src) };
  } catch {
    return null;
  }
}

/** The view-state key of a block's Source choice (kept by content, as 770's pages are). */
export const sourceKey = (key: string) => `diagram.source:${key}`;

/** An SVG drawing as a picture: its `data:` URL and the size it asks for (CSS pixels; null = the column's width). */
export interface Picture {
  url: string;
  width: number | null;
  height: number | null;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Elements that run, embed or load something, removed with their content by `stripSvgActive`. */
const ACTIVE = ["script", "foreignObject", "iframe", "object", "embed", "audio", "video", "handler", "listener", "set", "animate"];

/**
 * The text pass of the sanitiser, before DOMPurify: every element in `ACTIVE` with what it holds, every `on…`
 * attribute, and any `href` that is not a link inside the drawing (`#id`) or a `data:image/` picture. Repeated
 * until nothing changes, so a tag spliced from two halves (`<scr<script></script>ipt>`) cannot survive one pass.
 * (`set` and `animate` can write an `href` to `javascript:` at run time.)
 */
export function stripSvgActive(svg: string): string {
  let s = svg;
  for (let i = 0; i < 20; i++) {
    const before = s;
    for (const tag of ACTIVE) {
      s = s.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), "");
      s = s.replace(new RegExp(`<${tag}\\b[^>]*>`, "gi"), "");
      s = s.replace(new RegExp(`<\\/${tag}\\s*>`, "gi"), "");
    }
    // `/` separates attributes too (`<svg/onload=…>`).
    s = s.replace(/[\s/](?:on[a-z]+|formaction)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    s = s.replace(/[\s/]((?:xlink:)?href)\s*=\s*("([^"]*)"|'([^']*)'|[^\s>]+)/gi, (all, _n: string, _v: string, a?: string, b?: string) => {
      const v = (a ?? b ?? _v).trim();
      return /^#[\w.:-]*$/.test(v) || /^data:image\/(png|jpeg|gif|webp);/i.test(v) ? all : "";
    });
    if (s === before) break;
  }
  return s;
}

/**
 * The text of an SVG with everything that could run or load stripped: DOMPurify's SVG profile (and its
 * filters), no `<foreignObject>` (an HTML island), no `<script>`, no handler. `<style>` inside the SVG is
 * kept — in an `<img>` its rules reach only the picture, and Mermaid's drawing is styled by it. Null when
 * no `<svg>` element is left.
 */
export function sanitizeSvg(svg: string): string | null {
  // DOMPurify needs a DOM (it has one wherever the app runs); the text pass before it holds without one.
  const pre = stripSvgActive(svg);
  const clean = !DOMPurify.isSupported ? pre : DOMPurify.sanitize(pre, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ["style"],
    FORBID_TAGS: ["foreignObject", "foreignobject", "script", "iframe", "object", "embed"],
    FORBID_ATTR: ["onload", "onerror", "onclick", "onbegin", "onend", "onmouseover"],
  });
  const at = clean.search(/<svg[\s>]/i);
  if (at < 0) return null;
  let out = clean.slice(at);
  // Parsed as HTML, the root lost its namespace declaration; an image needs it back.
  if (!/^<svg[^>]*\sxmlns=/i.test(out)) out = out.replace(/^<svg/i, `<svg xmlns="${SVG_NS}"`);
  if (/\sxlink:href=/i.test(out) && !/^<svg[^>]*\sxmlns:xlink=/i.test(out)) out = out.replace(/^<svg/i, `<svg xmlns:xlink="http://www.w3.org/1999/xlink"`);
  return out;
}

const num = (v: string | undefined | null): number | null => {
  if (!v) return null;
  const m = /^\s*([\d.]+)\s*(px)?\s*$/.exec(v);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** The size an SVG asks for: its width and height in pixels, else its viewBox's, else none. */
export function svgSize(svg: string): { width: number | null; height: number | null } {
  const head = /^<svg\b[^>]*>/i.exec(svg)?.[0] ?? "";
  const attr = (n: string) => new RegExp(`\\s${n}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(head);
  const val = (n: string) => {
    const m = attr(n);
    return m ? (m[2] ?? m[3]) : null;
  };
  // Mermaid writes width="100%" and style="max-width: 640px".
  const maxW = /max-width:\s*([\d.]+)px/i.exec(val("style") ?? "");
  const vb = (val("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  const vbOk = vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0;
  let width = num(val("width")) ?? (maxW ? parseFloat(maxW[1]) : null) ?? (vbOk ? vb[2] : null);
  let height = num(val("height"));
  if (height === null && width !== null && vbOk) height = (width * vb[3]) / vb[2];
  if (width !== null && height === null) width = vbOk ? width : null;
  return { width, height: width === null ? null : height };
}

/** An SVG text as a picture (sanitised first); null when it holds no drawing. */
export function svgPicture(svg: string): Picture | null {
  const clean = sanitizeSvg(svg);
  if (!clean) return null;
  const { width, height } = svgSize(clean);
  return { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(clean)}`, width, height };
}

/** The first line of a Mermaid error, without its parser's caret art. */
export function mermaidError(message: string): string {
  const lines = message
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^[-^.\s]+$/.test(l));
  const text = lines.slice(0, 3).join(" — ");
  return (text || "Mermaid could not read this block").slice(0, 300);
}
