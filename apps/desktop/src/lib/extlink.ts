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

/**
 * Where a clicked outside link goes (nightshift backlog 172): a web tab
 * inside Nightloom, or the system browser. The Settings row picks the
 * plain click's place (`pref`, the browser until he picks — pass 0's
 * behaviour); ⌘ (Ctrl elsewhere) sends it to the other place (blocker
 * 315). Only http(s) can be a tab; mailto and the rest always go to the
 * system.
 */
export type LinkPref = "browser" | "tab";
export const LINK_PREF_KEY = "nightloom.links";

export function parseLinkPref(raw: string | null | undefined): LinkPref {
  return raw === "tab" ? "tab" : "browser";
}

export function linkRoute(url: string, pref: LinkPref, modifier: boolean): LinkPref {
  if (!/^https?:\/\//i.test(url)) return "browser";
  const tab = pref === "tab";
  return modifier !== tab ? "tab" : "browser";
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Whether two rectangles share any area — a dialog over a web tab's page
 *  hides the page, since a native view draws above every HTML layer. */
export function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** The HTML that floats over panes: while any of it overlaps a web tab's
 *  page, the page is hidden so the dialog or menu can be seen and used. */
export const OVERLAY_SELECTOR =
  '.settings-overlay, [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';
