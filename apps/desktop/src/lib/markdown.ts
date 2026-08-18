import { marked } from "marked";
import DOMPurify from "dompurify";

/** Render assistant markdown to sanitized HTML. */
export function renderMarkdown(src: string): string {
  const html = marked.parse(src, { async: false, gfm: true });
  return DOMPurify.sanitize(html);
}
