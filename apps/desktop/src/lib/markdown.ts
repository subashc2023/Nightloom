import { marked } from "marked";
import DOMPurify from "dompurify";
import { math } from "./math";
import "katex/dist/katex.min.css";

marked.use(math);

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
