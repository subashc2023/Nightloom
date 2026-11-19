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

/**
 * Item 879: what an SVG is drawn on. A picture shown as an `<img>` is its own document, so its default black
 * (and its `currentColor`, which is black there too) does not follow the app's text colour — on the dark looks a
 * model's diagram drew black on near-black. The rule, cheapest that holds:
 *
 * - `own`   — it paints its own background (a style `background` on the root, or a filled `<rect>` the full size
 *             of the drawing as its first rect): shown as it is.
 * - `theme` — every colour it names is `currentColor` or light, and nothing relies on the default black (a shape
 *             or text with no fill while nothing above it sets one): `currentColor` is set to the theme's text
 *             colour (`withInk`), drawn on the card.
 * - `paper` — anything else (default black, fixed dark colours, a colour we cannot read): a white backing, as
 *             the reply strip already shows every SVG — readable whatever the look.
 */
export type SvgBacking = "own" | "theme" | "paper";

const NAMED: Record<string, string> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", gray: "#808080", grey: "#808080",
  silver: "#c0c0c0", yellow: "#ffff00", orange: "#ffa500", navy: "#000080", lightgray: "#d3d3d3", lightgrey: "#d3d3d3",
  whitesmoke: "#f5f5f5", gainsboro: "#dcdcdc", ivory: "#fffff0", beige: "#f5f5dc", darkgray: "#a9a9a9", darkgrey: "#a9a9a9",
};

/** Relative luminance 0..1 of a CSS colour, or null when it is not a colour this can read. */
export function colourLuminance(c: string): number | null {
  let v = c.trim().toLowerCase();
  if (NAMED[v]) v = NAMED[v];
  let r: number, g: number, b: number;
  let m = /^#([0-9a-f]{3,4})$/.exec(v);
  if (m) [r, g, b] = [0, 1, 2].map((i) => parseInt(m![1][i] + m![1][i], 16));
  else if ((m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(v))) [r, g, b] = [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16));
  else if ((m = /^rgba?\(\s*([\d.]+)%?[\s,]+([\d.]+)%?[\s,]+([\d.]+)%?/.exec(v))) [r, g, b] = [m[1], m[2], m[3]].map(Number);
  else return null;
  const lin = (x: number) => {
    const s = x / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** The colours an SVG names in fill / stroke / color / stop-color, as attributes or in styles. */
function colours(svg: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[\s;{"'])(?:fill|stroke|color|stop-color)\s*(?:=\s*["']|:\s*)([^"';}>]+)/gi;
  for (let m = re.exec(svg); m; m = re.exec(svg)) out.push(m[1].trim());
  return out;
}

const attrOf = (tag: string, n: string): string | null => {
  const m = new RegExp(`\\s${n}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? (m[2] ?? m[3]) : null;
};

/** Item 879: what this SVG should be drawn on (see `SvgBacking`). */
export function svgBacking(svg: string): SvgBacking {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? "";
  if (/background(?:-color)?\s*:\s*(?!none|transparent)[^;"']+/i.test(attrOf(root, "style") ?? "")) return "own";
  const rect = /<rect\b[^>]*>/i.exec(svg)?.[0];
  if (rect) {
    const fill = (attrOf(rect, "fill") ?? /fill\s*:\s*([^;"']+)/i.exec(attrOf(rect, "style") ?? "")?.[1] ?? "").trim().toLowerCase();
    const { width, height } = svgSize(svg);
    const full = (n: string, whole: number | null) => {
      const v = (attrOf(rect, n) ?? "").trim();
      if (v === "100%") return true;
      const x = parseFloat(v);
      return whole !== null && Number.isFinite(x) && x >= whole * 0.95;
    };
    if (fill && fill !== "none" && fill !== "transparent" && full("width", width) && full("height", height)) return "own";
  }
  let themed = false;
  for (const c of colours(svg)) {
    const v = c.toLowerCase();
    if (v === "none" || v === "transparent" || v === "inherit" || v.startsWith("url(")) continue;
    if (v === "currentcolor") {
      themed = true;
      continue;
    }
    const l = colourLuminance(v);
    if (l === null || l < 0.45) return "paper";
    themed = true;
  }
  if (!themed) return "paper";
  // Default black: a shape or text with no fill of its own, while no group, the root or a style rule sets one.
  const setsFill = /<(?:svg|g)\b[^>]*\sfill\s*=/i.test(svg) || /<style[\s\S]*?fill\s*:/i.test(svg);
  if (!setsFill) {
    const shapes = svg.match(/<(?:text|path|rect|circle|ellipse|polygon)\b[^>]*>/gi) ?? [];
    if (shapes.some((t) => attrOf(t, "fill") === null && !/fill\s*:/i.test(attrOf(t, "style") ?? ""))) return "paper";
  }
  return "theme";
}

/** A CSS colour safe to write into an SVG's root style (theme tokens are ours, but never trust a string). */
const safeColour = (c: string) => (/^[#\w\s(),.%/-]+$/.test(c) ? c.trim() : null);

/** The SVG with its root's `color` (what `currentColor` reads) set to `ink`; an own root `color` is kept. */
export function withInk(svg: string, ink: string): string {
  const c = safeColour(ink);
  if (!c) return svg;
  return svg.replace(/^([\s\S]*?<svg\b)([^>]*)>/i, (_all, open: string, attrs: string) => {
    if (/\scolor\s*=/i.test(attrs) || /(?:^|[;"'\s])color\s*:/i.test(attrOf(`<x ${attrs}>`, "style") ?? "")) return `${open}${attrs}>`;
    const style = attrOf(`<x ${attrs}>`, "style");
    if (style === null) return `${open}${attrs} style="color:${c}">`;
    return `${open}${attrs.replace(/\sstyle\s*=\s*("[^"]*"|'[^']*')/i, ` style="color:${c};${style.replace(/"/g, "'")}"`)}>`;
  });
}

/** An SVG text as a picture on the right ground (item 879): its backing, and `currentColor` set to `ink` when themed. */
export function svgPictureOn(svg: string, ink: string): (Picture & { backing: SvgBacking }) | null {
  const clean = sanitizeSvg(svg);
  if (!clean) return null;
  const backing = svgBacking(clean);
  const text = backing === "theme" ? withInk(clean, ink) : clean;
  const { width, height } = svgSize(text);
  return { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`, width, height, backing };
}
