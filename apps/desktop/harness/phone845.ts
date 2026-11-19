// Item 845 batch 3 — see phone845.html. The phone's Home page (HomeFirst, with Home's stage) over a stubbed listener
// (window.fetch answers the /api routes), held for bin/snap. The phone's palettes are read from Remote.svelte's own
// :root blocks, so the page wears exactly the phone's tokens without mounting the whole phone page.
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import { mount, unmount, flushSync } from "svelte";
import remoteSrc from "../src/remote/Remote.svelte?raw";
import HomeFirst from "../src/remote/HomeFirst.svelte";
import { Client, type RemoteState } from "../src/remote/client";
import { applyLook } from "../src/remote/look";
import { stage as kept, keep, readKept, STAGE_KEY } from "../src/lib/homeStage/stageState.svelte";
import { homeTasks } from "./home845/fixtures";

const q = new URLSearchParams((window as unknown as { __h9q?: string }).__h9q ?? location.search);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ago = (min: number) => Date.now() - min * 60_000;
const s = q.get("s") ?? "watch";
const away = q.get("away") === "1";

// The phone's :root token blocks, verbatim from Remote.svelte (`:global(:root…) { … }`).
{
  const out: string[] = [];
  const lines = remoteSrc.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*:global\(((?::root|html, body).*)\)\s*\{\s*$/.exec(lines[i]);
    if (!m) continue;
    const body: string[] = [];
    for (i++; i < lines.length && !/^\s*\}\s*$/.test(lines[i]); i++) body.push(lines[i]);
    out.push(`${m[1]} {\n${body.join("\n")}\n}`);
  }
  document.head.insertAdjacentHTML("beforeend", `<style>${out.join("\n")}\nhtml,body{margin:0;background:var(--paper);font-family:var(--sans);-webkit-text-size-adjust:100%}</style>`);
  (window as unknown as { __tokens: number }).__tokens = out.length;
}
// bin/snap's hidden window runs no animation: draw every arrival at its end state.
document.head.insertAdjacentHTML("beforeend", "<style>*,*::before,*::after{animation:none!important;transition:none!important}.lk-veil,.lk-scan{display:none!important}</style>");

const SCAN = "Three things need you today; the rest is handled.\n\n## Needs you\n- The landlord's lease question — a reply is due Friday.\n- Mom asked about Saturday.\n- The round-6 pick is waiting.\n\n## Today\n- 9:00 AM stand-up\n- 3:30 PM design review (moved from 2:00 PM)\n\n## Handled overnight\n1. The night run merged two fixes; CI passed.\n2. Filed one receipt.\n\n## Projects\n- Nightloom: build 212d1d4f installed.\n- nightshift-code: 4 items shipped, 1 held blocker.";
const told: string[] = [];
const closed: string[] = [];
const notes: string[] = [];
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
const refuse = () => new Response("Home's stage answers only from the Mac — your click was not sent. Try again when the Mac is reachable.", { status: 503 });
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  const p = url.pathname.replace(/^.*\/api/, "");
  const method = init?.method ?? "GET";
  if (p === "/home/today") return json({ points: 0.3, cap: 5, week: 41, five_hour: 12, stopped: null });
  if (p === "/home/feed") return json({ rows: [
    { at: new Date(ago(50)).toISOString(), kind: "done", label: null, chat: null, project: "Nightloom", line: "Night run finished — 2 fixes merged, CI passed" },
    { at: new Date(ago(90)).toISOString(), kind: "done", label: "Weekly backup", chat: null, project: null, line: "Weekly backup ran on time" },
  ], seen_at: new Date(ago(120)).toISOString(), as_of: ago(1), home: { project: "home", chat: "h-today" } });
  if (p === "/home/scan") return json({ scan: { date: "2026-11-19", text: SCAN, ran_at: ago(240), today: true, skipped: null } });
  if (p === "/home/held") return json({ blockers: [] });
  if (p === "/home/routes") return json({ cards: [], held: [], started: [] });
  if (p === "/home/sources") return json([]);
  if (p === "/push/feed") return json({ rows: [{ what: "question", chat: "h-today", label: "Home", project: "home", at: ago(5) }] });
  if (p === "/jobs") return json({ jobs: [], now: new Date().toISOString() });
  if (p === "/running") return json({ chats: [], contexts: {} });
  if (p === "/home/tasks") return json(homeTasks.filter((t) => !closed.includes(t.id)));
  if (p === "/home/tasks/event" && method === "POST") {
    if (away) return refuse();
    told.push(String(JSON.parse(String(init?.body ?? "{}")).line ?? ""));
    return json({ ok: true });
  }
  if (p === "/home/tasks/focus" && method === "POST") return away ? refuse() : json({ ok: true });
  const close = /^\/home\/tasks\/([^/]+)\/close$/.exec(p);
  if (close && method === "POST") {
    if (away) return refuse();
    closed.push(decodeURIComponent(close[1]));
    return json({ ok: true });
  }
  if (p === "/notes") return json(notes.map((name) => ({ name, bytes: 1, modified: new Date().toISOString(), summary: "", kind: "markdown" })));
  if (p.startsWith("/notes/") && method === "PUT") {
    notes.push(decodeURIComponent(p.slice("/notes/".length)));
    return json({ ok: true });
  }
  if (p.startsWith("/chats")) return json([]);
  return json(null, 404);
}) as typeof fetch;

const remote = { project: "home", active_chat: null, busy: false, connected: true, engine: "claude-code", pending: [], host: away ? "serve" : "mac" } as unknown as RemoteState;
const client = new Client("t0k", "");
const props = () => ({
  client,
  active: (away ? "away" : "mac") as never,
  macPaired: true,
  remote,
  openLabel: null,
  fil: q.get("classic") !== "1",
  resume: null,
  onopen: (chat: string) => ((window as unknown as { __opened: string }).__opened = chat),
  onjobs: () => {},
  ondrawer: () => {},
  onnew: () => {},
  onhold: () => {},
});

async function run() {
  localStorage.clear();
  applyLook(q.get("classic") === "1" ? "classic" : "filament");
  const TAB: Record<string, string> = { brief: "brief", timeline: "task:moving-the-review", todo: "task:working-your-list", triage: "task:sorting-what-arrived", browse: "task:renewing-the-permit", run: "task:merge-round-t", research: "task:cache-pricing" };
  Object.assign(kept, { focus: TAB[s] ?? "watch", strip: "open", stripFor: "", ui: {} });
  const target = document.getElementById("app")!;
  let root = mount(HomeFirst, { target, props: props() });
  flushSync();
  await wait(900);
  // restart=1: his click in the view, the stage saved, the page torn down, the stage read back from storage only, and
  // the page mounted again — what the shot then shows is what survived.
  let restart = "";
  if (q.get("restart") === "1") {
    const click = (sel: string) => document.querySelector<HTMLElement>(sel)?.click();
    if (s === "timeline") click(".t-chg .jc .jb.send");
    if (s === "todo") click(".d-box:not(.on)");
    if (s === "triage") {
      click(".g-card:not(.isopen) .nd .h9-acts .jb.send");
      flushSync();
      const inp = document.querySelector<HTMLInputElement>(".nd-reply input");
      if (inp) (inp.value = "Yes — tell her I'll bring dessert"), inp.dispatchEvent(new Event("input", { bubbles: true }));
      flushSync();
    }
    if (s === "browse") click(".w-narrow .h9-acts .jb.send");
    if (s === "run") click(".h9-ph-tools .jb.danger");
    if (s === "research") {
      click(".s-claim .jb");
      click(".y-end .jb.send");
    }
    if (s === "brief") click(".h9-ph-tools .jb:not(.send)");
    await wait(300);
    flushSync();
    keep();
    const saved = localStorage.getItem(STAGE_KEY) ?? "";
    unmount(root);
    Object.assign(kept, readKept(saved));
    root = mount(HomeFirst, { target, props: props() });
    flushSync();
    await wait(900);
    restart = ` restart=${saved.length}B told=${told.length} notes=${notes.length}`;
  }
  void root;
  const st = document.querySelector<HTMLElement>("[data-phone-stage]");
  const bad: string[] = [];
  for (const el of st?.querySelectorAll<HTMLElement>("*") ?? []) {
    if (el instanceof SVGElement) continue;
    if (el.hasAttribute("data-ellipsis")) continue; // cut on purpose (a URL), its whole text in its title
    const dx = el.scrollWidth - el.clientWidth;
    if (dx > 1 && /(hidden|clip|auto|scroll)/.test(getComputedStyle(el).overflowX) && !/h9-tabs|h9-doing|b-counts|b-count|t-track|t-scroll/.test(el.className)) bad.push(`${el.className.split(" ")[0]} +${dx}`);
  }
  const wide = Math.max(document.documentElement.scrollWidth, document.querySelector<HTMLElement>(".home")?.scrollWidth ?? 0) - innerWidth;
  // Every box, not only the page (845 batch 4: a Needs-you pile ran off a 375 px phone while the page measured
  // sideways=0 — an ancestor clipped it). A box counts as out when it reaches past the stage's own edges, unless it
  // sits inside a sideways scroller of its own (the tab row, Timeline's track), which the cut check above covers.
  const out: string[] = [];
  const sr = st?.getBoundingClientRect();
  if (st && sr) {
    const scrolls = (n: Element) => /(auto|scroll)/.test(getComputedStyle(n).overflowX);
    for (const el of st.querySelectorAll<Element>("*")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      let a = el.parentElement;
      let inScroller = false;
      while (a && a !== st) {
        if (scrolls(a)) {
          inScroller = true;
          break;
        }
        a = a.parentElement;
      }
      if (inScroller) continue;
      const over = Math.max(r.right - sr.right, sr.left - r.left);
      if (over > 1) out.push(`${(el.getAttribute("class") ?? el.tagName).split(" ")[0]} +${Math.round(over)}`);
    }
  }
  const piles = [...document.querySelectorAll<HTMLElement>(".g-pile")].map((p) => Math.round(p.getBoundingClientRect().width)).join("/");
  (window as unknown as { __capset: (m: string) => void }).__capset(
    `845p s=${s}${away ? " away" : ""} tokens=${(window as unknown as { __tokens: number }).__tokens} stage=${st ? `${Math.round(st.getBoundingClientRect().width)}w ${st.className.replace(/svelte-\S+/g, "").replace(/\s+/g, " ").trim()}` : "MISSING"} tabs=${[...document.querySelectorAll(".h9-tab .tn")].map((n) => n.textContent).join("|")} on=${document.querySelector(".h9-tab.on .tn")?.textContent ?? "-"} sections=${document.querySelectorAll("[data-home-section]").length} tell=${document.querySelector("[data-home-tell]") ? "yes" : "no"} cut=${bad.length}${bad.length ? ` (${bad.slice(0, 4).join(", ")})` : ""} sideways=${wide} out=${out.length}${out.length ? ` (${out.slice(0, 4).join(", ")})` : ""}${piles ? ` piles=${piles}` : ""}${restart} vw${innerWidth}`,
  );
}
// The page is folded into one file with this script in <head>: wait for the body.
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void run());
else void run();
