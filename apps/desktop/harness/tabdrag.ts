// Backlog 195 harness — see tabdrag.html.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import { mount, flushSync } from "svelte";
import TabStrip from "../src/lib/TabStrip.svelte";
import { app } from "../src/lib/state.svelte";
import * as tabs from "../src/lib/tabs";
import { tabDrag } from "../src/lib/tabDrag.svelte";

const q = new URLSearchParams(location.search);
const src = Number(q.get("src") ?? "0");
const to = q.get("to") ?? "own";
const stage = q.get("stage") ?? "after";

const names = ["alpha", "beta", "gamma", "delta"];
// Titles only; nothing else of a session is read by the strip.
app.sessions = names.map((n) => ({ id: n, title: n[0].toUpperCase() + n.slice(1) })) as unknown as typeof app.sessions;
const w = tabs.emptyWorkspace();
w.panes[0].tabs = names.map((n) => tabs.makeTab({ kind: "chat", session: n }));
w.panes[0].active = w.panes[0].tabs[0].id;
app.tabs = w;
const pane = app.tabs.panes[0];

const sec = document.createElement("section");
sec.className = "pane";
sec.dataset.pane = pane.id;
document.getElementById("root")!.append(sec);
mount(TabStrip, { target: sec, props: { pane } });
flushSync();

const tabEls = () => Array.from(document.querySelectorAll<HTMLElement>("[data-tab]"));
function centre(el: Element) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
function fire(target: EventTarget, type: string, x: number, y: number) {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, pointerId: 1 }));
}

const els = tabEls();
const from = centre(els[src]);
let dest: { x: number; y: number };
if (to === "nowhere") dest = { x: 600, y: 260 };
else {
  const slot = Number(to === "own" ? src : to);
  dest = slot < els.length
    ? { x: els[slot].getBoundingClientRect().left + 6, y: from.y }
    : { x: els[els.length - 1].getBoundingClientRect().right + 20, y: from.y };
}

const before = pane.tabs.map((t) => t.content.kind === "chat" ? t.content.session : "?").join(",");
fire(els[src], "pointerdown", from.x, from.y);
fire(document.body, "pointermove", from.x + 6, from.y);
fire(document.body, "pointermove", dest.x, dest.y);
flushSync();
const mid = {
  plan: JSON.stringify(tabDrag.plan),
  ghost: !!document.querySelector(".tab-ghost"),
  marker: document.querySelectorAll(".tab-drop").length,
};
let flying = "n/a";
if (stage !== "mid") {
  fire(document.body, "pointerup", dest.x, dest.y);
  flushSync();
  // Right after the release: is the ghost flying home (a snap), and from where to where?
  const g = document.querySelector<HTMLElement>(".tab-ghost");
  const home = tabEls()[src]?.getBoundingClientRect();
  flying = g
    ? `ghost .home=${g.classList.contains("home")} left ${g.style.left} → tab at ${Math.round(home?.left ?? -1)}px, transition ${getComputedStyle(g).transitionDuration}`
    : "no ghost (the drop did something)";
}
setTimeout(() => {
  const order = pane.tabs.map((t) => t.content.kind === "chat" ? t.content.session : "?").join(",");
  const active = tabs.activeTab(pane).content;
  document.getElementById("cap")!.textContent =
    `dpr ${devicePixelRatio} · drag tab ${src} (${names[src]}) to ${to} · stage ${stage}\n` +
    `mid: plan ${mid.plan} · ghost ${mid.ghost} · markers ${mid.marker}\n` +
    `release: ${flying}\n` +
    `before ${before}\nafter  ${order} · active ${active.kind === "chat" ? active.session : "?"} · ghost now ${!!document.querySelector(".tab-ghost")}`;
}, stage === "mid" ? 0 : 300);
