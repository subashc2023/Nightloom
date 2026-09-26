/*
 * Sources inline, where they are used (nightshift backlog 213).
 *
 * The model is asked (the Claude Code engine's engine note and the API
 * engine's web_search description, both in `nightloom-service`) to put a
 * citation marker right after each sentence a web source supports: a
 * Markdown link whose text is the source's number in brackets and whose
 * title is the page's title — `[[1]](https://host/page "Page title")`.
 * This extension draws such a link as a small chip beside the sentence:
 * the site's name on it, the page's title and domain on hover (`data-tip`,
 * the app's tooltip delegate), and a click routed like every other link
 * (`App.svelte`'s capture handler: a web tab or the browser, by the links
 * setting, ⌘ for the other). A link whose text is not a bare number is an
 * ordinary link and is left alone.
 *
 * The foot list the CLI's WebSearch reminder asks for ("include the
 * sources … using markdown hyperlinks"), if the model still writes one,
 * folds to a closed *All sources* at the end of the reply rather than
 * being dropped: a "Sources" heading or line followed by a list, with
 * nothing after it.
 */
import type { MarkedExtension, Token, Tokens } from "marked";

/** `[1]`, `1` — what a citation marker's link text is. */
const MARKER = /^\[?\d{1,3}\]?$/;

/** A heading or lead line naming a sources list. */
const SOURCES_LABEL = /^(all\s+)?(sources|references|citations)$/;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The site's name for a chip: the host without `www.`. Null when the
 *  href is not a web address (then the link stays a plain link). */
export function siteOf(href: string): string | null {
  try {
    const u = new URL(href);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** The chip for one marker, or null when the link is not a citation. */
export function citeChip(href: string, text: string, title: string | null | undefined): string | null {
  if (!MARKER.test(text.trim())) return null;
  const site = siteOf(href);
  if (!site) return null;
  const n = text.trim().replace(/[[\]]/g, "");
  const tipText = title && title.trim() ? `${title.trim()} — ${site}` : site;
  return (
    `<a class="cite-chip" href="${escapeHtml(href)}" data-cite="${n}" data-tip="${escapeHtml(tipText)}">` +
    `${escapeHtml(site)}</a>`
  );
}

function labelOf(t: Token): string | null {
  if (t.type !== "heading" && t.type !== "paragraph") return null;
  const text = (t as Tokens.Heading | Tokens.Paragraph).text;
  return text
    .replace(/[*_:`]/g, "")
    .trim()
    .toLowerCase();
}

/** Where a trailing "Sources" block starts, or -1: a label token, then a
 *  list, then only blank space to the end. */
export function trailingSources(tokens: Token[]): number {
  let end = tokens.length;
  while (end > 0 && tokens[end - 1].type === "space") end--;
  if (end < 2) return -1;
  const list = tokens[end - 1];
  if (list.type !== "list") return -1;
  let i = end - 2;
  while (i >= 0 && tokens[i].type === "space") i--;
  if (i < 0) return -1;
  const label = labelOf(tokens[i]);
  return label !== null && SOURCES_LABEL.test(label) ? i : -1;
}

function htmlToken(text: string): Tokens.HTML {
  return { type: "html", raw: "", pre: false, text, block: true };
}

/** The marked extension: citation links as chips, a trailing sources
 *  list folded under *All sources*. */
export const cite: MarkedExtension = {
  renderer: {
    link(token: Tokens.Link) {
      return citeChip(token.href, token.text, token.title) ?? false;
    },
  },
  hooks: {
    processAllTokens(tokens) {
      const at = trailingSources(tokens as Token[]);
      if (at < 0) return tokens;
      let end = tokens.length;
      while (end > 0 && tokens[end - 1].type === "space") end--;
      const listToken = tokens[end - 1];
      const folded = [
        htmlToken('<details class="all-sources"><summary>All sources</summary>\n'),
        listToken,
        htmlToken("</details>\n"),
      ];
      tokens.splice(at, tokens.length - at, ...folded);
      return tokens;
    },
  },
};
