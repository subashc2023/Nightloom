// Backlog 379 harness — see fork379.html.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import { mount, flushSync } from "svelte";
import Sidebar from "../src/lib/Sidebar.svelte";
import TabStrip from "../src/lib/TabStrip.svelte";
import { app } from "../src/lib/state.svelte";
import * as tabs from "../src/lib/tabs";
import { saveOpen } from "../src/lib/forkTree";

// The parent's forks shown, so the fork's row is drawn (indented under it).
saveOpen(new Set(["6be24d46-parent"]));

const cap = document.getElementById("cap")!;
const log = (s: string) => (cap.textContent += s + "\n");
const when = new Date(Date.now() - 600_000).toISOString();
const T = "I want you to do a pretty long piece of work on the parser";
const row = (id: string, title: string, from?: object) => ({ id, title, mode: "normal", kind: "chat", modified: when, ...(from ? { forked_from: from } : {}) });
app.sessions = [
  row("c1033f28-fork", T, { session: "6be24d46-parent", index: 4 }),
  row("6be24d46-parent", T),
  row("dddd4444-cont", "Continued work", { session: "6be24d46-parent", index: 30, reason: "handoff" }),
  row("eeee5555-orphan", "Orphan fork", { session: "gone0000-deleted", index: 2 }),
] as unknown as typeof app.sessions;
const w = tabs.emptyWorkspace();
w.panes[0].tabs = app.sessions.map((s) => tabs.makeTab({ kind: "chat", session: s.id }));
w.panes[0].active = w.panes[0].tabs[0].id;
app.tabs = w;

mount(Sidebar, { target: document.getElementById("side")! });
const paneEl = document.getElementById("pane")!;
paneEl.dataset.pane = app.tabs.panes[0].id;
mount(TabStrip, { target: paneEl, props: { pane: app.tabs.panes[0] } });
flushSync();

setTimeout(() => {
  for (const tabEl of document.querySelectorAll<HTMLElement>("[data-tab]")) {
    const t = tabEl.getBoundingClientRect();
    const mark = tabEl.querySelector<HTMLElement>(".fork");
    const name = tabEl.querySelector<HTMLElement>(".name")!;
    const m = mark?.getBoundingClientRect();
    const inside = m ? m.left >= t.left && m.right <= t.right && m.width > 0 : null;
    log(
      `tab w=${t.width.toFixed(0)} mark=${mark ? `${mark.textContent} w=${m!.width.toFixed(1)} inside=${inside} tip=${JSON.stringify(mark.getAttribute("aria-label"))}` : "none"} name-truncated=${name.scrollWidth > name.clientWidth} "${name.textContent}"`,
    );
  }
  for (const r of document.querySelectorAll<HTMLElement>(".session-row .snippet")) {
    const mark = r.querySelector<HTMLElement>(".fork");
    const s = r.getBoundingClientRect();
    const m = mark?.getBoundingClientRect();
    log(
      `row mark=${mark ? `${mark.textContent} visible=${!!m && m.width > 0 && m.right <= s.right} tip=${JSON.stringify(mark.getAttribute("aria-label"))}` : "none"} truncated=${r.scrollWidth > r.clientWidth} "${r.textContent?.trim()}"`,
    );
  }
}, 300);
