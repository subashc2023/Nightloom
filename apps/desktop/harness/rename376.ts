// Backlog 376 harness — see rename376.html.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import { mount, flushSync, tick } from "svelte";
import Sidebar from "../src/lib/Sidebar.svelte";
import TabStrip from "../src/lib/TabStrip.svelte";
import { app } from "../src/lib/state.svelte";
import * as tabs from "../src/lib/tabs";

const cap = document.getElementById("cap")!;
const log = (s: string) => (cap.textContent += s + "\n");
const when = new Date(Date.now() - 600_000).toISOString();
const row = (id: string, title: string) => ({ id, title, mode: "normal", kind: "chat", modified: when });
app.sessions = [row("aaaa1111-one", "Plan the trip to Kyoto"), row("bbbb2222-two", "Rust borrow checker notes")] as unknown as typeof app.sessions;
const w = tabs.emptyWorkspace();
w.panes[0].tabs = app.sessions.map((s) => tabs.makeTab({ kind: "chat", session: s.id }));
w.panes[0].active = w.panes[0].tabs[0].id;
app.tabs = w;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sel(where: string) {
  const el = document.activeElement as HTMLInputElement | null;
  const ok = !!el && el.tagName === "INPUT" && typeof el.value === "string" && el.selectionStart === 0 && el.selectionEnd === el.value.length && el.value.length > 0;
  log(`${where}: focused=${el?.tagName ?? "none"} value=${JSON.stringify(el?.value)} selection=${el?.selectionStart}..${el?.selectionEnd} of ${el?.value.length} -> ${ok ? "PASS" : "FAIL"}`);
  return el;
}
function esc(el: HTMLElement) {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  flushSync();
}
function menuItem(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((b) => b.textContent?.trim() === label);
}

mount(Sidebar, { target: document.getElementById("side")! });
const paneEl = document.getElementById("pane")!;
paneEl.dataset.pane = app.tabs.panes[0].id;
mount(TabStrip, { target: paneEl, props: { pane: app.tabs.panes[0] } });
flushSync();

(async () => {
  // Sidebar: right-click the second row → Rename.
  const rowBtn = document.querySelectorAll<HTMLElement>(".session-row")[1];
  rowBtn.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: 80 }));
  flushSync();
  const r1 = menuItem("Rename");
  r1?.focus();
  r1?.click();
  flushSync();
  await tick();
  await sleep(30);
  const f1 = sel("sidebar Rename");
  if (f1) {
    esc(f1);
    const shown = document.querySelectorAll(".session-row .snippet")[1]?.textContent?.trim();
    log(`sidebar Esc: field gone=${!document.querySelector("#side input.rename")} row reads ${JSON.stringify(shown)}`);
  }
  // Tab strip: right-click the second tab → Rename.
  const tabEl = document.querySelectorAll<HTMLElement>("[data-tab]")[1];
  tabEl.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 20 }));
  flushSync();
  const r2 = menuItem("Rename");
  log(`tab menu has Rename: ${!!r2}`);
  r2?.focus();
  r2?.click();
  flushSync();
  await tick();
  await sleep(30);
  const f2 = sel("tab Rename");
  if (f2) {
    esc(f2);
    const shown = document.querySelectorAll("[data-tab]")[1]?.querySelector(".name")?.textContent?.trim();
    log(`tab Esc: field gone=${!document.querySelector("[data-tab] input.rename")} tab reads ${JSON.stringify(shown)}`);
  }
  // The menu's existing Close, by the same route (does reading `t` after `menuFor = null` still find the tab?).
  const before = app.tabs.panes[0].tabs.length;
  const tab0 = document.querySelectorAll<HTMLElement>("[data-tab]")[0];
  tab0.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 20 }));
  flushSync();
  menuItem("Close")?.click();
  flushSync();
  await sleep(30);
  log(`tab menu Close: tabs ${before} -> ${app.tabs.panes[0].tabs.length}`);
  document.body.dataset.done = "1";
})();
