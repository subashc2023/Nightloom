/**
 * Item 770: whether a page inside a reply opens drawn or as a one-line card (ChatGPT's dial, 818 §4). Drawn by
 * default; kept per machine in localStorage, as the typed-maths switch is. A page he opened or closed himself
 * keeps that (`viewState`, by its content), whatever this says.
 */
const KEY = "nightloom.replyPages.collapsed";

export function loadPagesCollapsed(storage: Pick<Storage, "getItem"> | undefined = typeof localStorage === "undefined" ? undefined : localStorage): boolean {
  try {
    return storage?.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export const replyPagePrefs = $state({ collapsed: loadPagesCollapsed() });

export function setPagesCollapsed(on: boolean): void {
  replyPagePrefs.collapsed = on;
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    // best-effort
  }
}
