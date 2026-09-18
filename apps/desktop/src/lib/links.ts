/**
 * Links in rendered text go to the system browser, never to the webview
 * (his report, 2026-09-18: a link in a reply "opens up that link within the
 * Nightloom app itself, but it covers the entire screen … no way to go back
 * … without quitting the app"). The transcript's Markdown renders plain
 * `<a href>`s and nothing intercepted them; WKWebView then navigated the
 * whole window away. One capture-phase click listener on the document
 * (`App.svelte`) asks this for the URL to hand to the OS.
 */

/** The outside URL an anchor click should open in the browser, or `null`
 *  when the click is the app's own business: no anchor, no href, a
 *  same-origin or fragment link, a `[[note]]` link (`NoteView` follows
 *  those itself), a modified click meant for something else. */
export function externalHref(
  target: EventTarget | null,
  origin: string,
): string | null {
  const el = target instanceof Element ? target : null;
  const a = el?.closest("a");
  if (!a) return null;
  const href = a.getAttribute("href");
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
