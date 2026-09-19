/**
 * Links in rendered text go to the system browser, never to the webview
 * (his report, 2026-09-18: a link in a reply "opens up that link within the
 * Nightloom app itself, but it covers the entire screen … no way to go back
 * … without quitting the app"). The transcript's Markdown renders plain
 * `<a href>`s and nothing intercepted them; WKWebView then navigated the
 * whole window away. One capture-phase click listener on the document
 * (`App.svelte`) asks this for the URL to hand to the OS.
 */

/** The outside URL an anchor's `href` should open in the browser, or
 *  `null` when the click is the app's own business: no href, a fragment,
 *  a same-origin link, a `[[note]]` link (`NoteView` follows those
 *  itself). Pure over the href so the suite can pin it without a DOM. */
export function externalHref(href: string | null, origin: string): string | null {
  if (!href || href.startsWith("#")) return null;
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") {
    return null;
  }
  if (url.origin === origin) return null;
  return url.href;
}
