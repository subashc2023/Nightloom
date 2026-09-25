import { marked } from "marked";
import DOMPurify from "dompurify";
import { math, renderMath } from "./math";
import { tilde } from "./tilde";
import "katex/dist/katex.min.css";

marked.use(math);
marked.use(tilde);

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

/** Render assistant markdown to sanitized HTML. */
export function renderMarkdown(src: string): string {
  const html = marked.parse(src, { async: false, gfm: true });
  return DOMPurify.sanitize(html, ALLOW_MATHML);
}

/**
 * One formula as sanitized HTML — the formatted note editor's math widget
 * (nightshift backlog 150), through the same KaTeX call and the same
 * sanitizer as a formula inside `renderMarkdown`.
 */
export function renderMathHtml(tex: string, display: boolean): string {
  return DOMPurify.sanitize(renderMath(tex, display), ALLOW_MATHML);
}
