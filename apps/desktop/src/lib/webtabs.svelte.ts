/**
 * Web tabs (nightshift backlog 172): a link he clicks opens as a page in a
 * tab beside the chat. The tab model holds the address and title
 * (`tabs.ts`, kind `web`); the page is a child webview of the window
 * (`src-tauri/src/webtab.rs`), labelled from the tab's id and placed over
 * the pane by `WebView.svelte`. This module is the glue: the click router,
 * the Settings preference, the page's reports (address, title, favicon)
 * back into the tab, and the rule that a webview dies with its tab.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as api from "./api";
import * as tabs from "./tabs";
import { app, activateTab, addToast } from "./state.svelte";
import { LINK_PREF_KEY, PageQueue, linkRoute, parseLinkPref, type LinkPref } from "./extlink";

function loadPref(): LinkPref {
  try {
    return parseLinkPref(localStorage.getItem(LINK_PREF_KEY));
  } catch {
    return "browser";
  }
}

export const web = $state({
  /** Where a plain click on an outside link goes. */
  pref: loadPref() as LinkPref,
  /** What the pages report that the tab model does not keep, by label. */
  live: {} as Record<string, { loading?: boolean; favicon?: string }>,
});

export function setLinkPref(p: LinkPref): void {
  web.pref = p;
  try {
    localStorage.setItem(LINK_PREF_KEY, p);
  } catch {
    // A preference that does not persist still applies for this run.
  }
}

export function webLabel(tabId: string): string {
  return `web-${tabId}`;
}

/** The web tab whose webview is `label`, wherever it sits. */
function tabOfLabel(label: string): tabs.Tab | undefined {
  return tabs.allTabs(app.tabs).find((t) => t.content.kind === "web" && webLabel(t.id) === label);
}

/**
 * Open `url` as a web tab: the tab already showing it anywhere is brought
 * forward; else a new tab after the focused pane's active one — beside
 * the chat, never over it.
 */
export async function openWebTab(url: string): Promise<void> {
  if (!tabs.isWebUrl(url)) return;
  const content: tabs.TabContent = { kind: "web", url };
  const found = tabs.findAnywhere(app.tabs, content);
  if (found) {
    await activateTab(found.id);
    return;
  }
  const t = tabs.land(app.tabs, tabs.focusedPane(app.tabs), content, "new");
  await activateTab(t.id);
}

export function openInBrowser(url: string): void {
  api.openUrl(url).catch((err) => addToast(`Could not open the link: ${String(err)}`));
}

/** The click router: a web tab or the browser, by the setting and ⌘. */
export function routeLink(url: string, modifier: boolean): void {
  if (linkRoute(url, web.pref, modifier) === "tab") void openWebTab(url);
  else openInBrowser(url);
}

/** Labels whose webview this run created or adopted; closed with their tab. */
const opened = new Set<string>();

export function noteOpened(label: string): void {
  opened.add(label);
}

/** Each label's create / hide / close calls, one at a time. */
const pages = new PageQueue();

/** Create (or show again) the page of web tab `label` at the pane rectangle. */
export function openPage(
  label: string,
  args: { url: string; x: number; y: number; w: number; h: number; vh: number },
): Promise<void> {
  noteOpened(label);
  return pages.run(label, () => invoke<void>("web_open", { label, ...args }));
}

/** Move the page of `label` to the pane rectangle, or hide it (its tab
 *  went to the back, a dialog is over it, a drag is on) — after any create
 *  in flight has landed, so a page never appears after its hide. */
export function placePage(
  label: string,
  args: { x: number; y: number; w: number; h: number; vh: number; visible: boolean },
): void {
  pages.run(label, () => invoke("web_bounds", { label, ...args })).catch(() => {});
}

/**
 * Close every webview no tab holds any more — its tab was closed (⌘W, ×,
 * a pane closing, a project switch resetting the workspace). Called from
 * an effect in `App.svelte` on every change of the tabs.
 */
export function closeOrphans(): void {
  const live = new Set(
    tabs
      .allTabs(app.tabs)
      .filter((t) => t.content.kind === "web")
      .map((t) => webLabel(t.id)),
  );
  for (const label of [...opened]) {
    if (live.has(label)) continue;
    opened.delete(label);
    delete web.live[label];
    // After its `web_open` settles: a page still being created when its
    // tab closed would otherwise outlive the close.
    pages.run(label, () => invoke("web_close", { label })).catch(() => {});
  }
}

let started = false;
/**
 * Once per page load: close any webview a previous load of the main page
 * left behind (its tabs are gone — the workspace is not kept), and start
 * listening to the pages.
 */
export async function initWebTabs(): Promise<void> {
  if (started) return;
  started = true;
  try {
    const left = await invoke<string[]>("web_labels");
    for (const label of left) {
      if (!tabOfLabel(label)) void invoke("web_close", { label }).catch(() => {});
    }
  } catch {
    // Not in the app (the harness, a test): nothing to close.
  }
  try {
    await listen<{ label: string; url?: string; title?: string; loading?: boolean; favicon?: string }>(
      "web-state",
      (e) => {
        const p = e.payload;
        const t = tabOfLabel(p.label);
        if (!t || t.content.kind !== "web") return;
        if (typeof p.url === "string" && tabs.isWebUrl(p.url)) t.content.url = p.url;
        if (typeof p.title === "string") t.content.title = p.title.slice(0, 300);
        const live = (web.live[p.label] ??= {});
        if (typeof p.loading === "boolean") live.loading = p.loading;
        if (typeof p.favicon === "string" && tabs.isWebUrl(p.favicon)) live.favicon = p.favicon;
      },
    );
    // A page's `window.open` / `target=_blank`: another web tab, as if he
    // had clicked it here — the webview itself refuses to open a window.
    await listen<[string, string]>("web-new-window", (e) => {
      const [, url] = e.payload;
      if (tabs.isWebUrl(url)) void openWebTab(url);
    });
  } catch {
    // No event bridge outside the app.
  }
}
