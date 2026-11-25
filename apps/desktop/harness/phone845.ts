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
// Items 944–946: real944=1 draws the page on data put on it as window.__real (his own feed and held blockers, read
// from copies — never committed); empty944=1 is a Home with nothing in it yet; handled=1 opens the Handled list.
const real = q.get("real944") === "1" ? ((window as unknown as { __real?: { feed: unknown[]; seen_at: string | null; blockers: { id: string; question: string; fields?: Record<string, string> }[] } }).__real ?? null) : null;
const empty = q.get("empty944") === "1";
// (Set again in run(), after its storage reset — set here only, the flag was cleared before the page read it.)
const handledKept = () => {
  if (q.get("handled") === "1") localStorage.setItem("nightloom.remote.home", JSON.stringify({ handledOpen: true }));
  else localStorage.removeItem("nightloom.remote.home");
};
handledKept();

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
// Item 947: stress modes (x=crowded|f500|slow|down|flaky) — a crowded Home, a route that answers 500, a slow network,
// the host gone, a host that answers then fails. window.__x.flip() turns flaky's failure on.
const X = q.get("x") ?? "";
const X_LONG = "A".repeat(90) + "-averyveryverylongprojectnamewithoutanyspaces-" + "B".repeat(60);
const xFail = { on: X === "f500" || X === "down" };
const xPush = X === "crowded" ? Array.from({ length: 40 }, (_, i) => ({ what: ["question", "approval", "stuck", "set_aside"][i % 4], chat: `c${i}`, label: i === 3 ? X_LONG : i % 5 === 0 ? null : `Chat number ${i} about something fairly long to name`, project: "p", at: ago(i * 7 + 1) })) : null;
const xFeed = X === "crowded" ? Array.from({ length: 90 }, (_, i) => ({ at: new Date(ago(i * 11 + 3)).toISOString(), kind: ["done", "failed", "limit", "job_done"][i % 4], label: i === 2 ? X_LONG : `Run ${i}`, chat: i % 3 ? `c${i}` : null, project: null, line: i === 4 ? X_LONG : `Line ${i}: ${"it did a long thing and then another long thing ".repeat(i % 3)}finished` })) : null;
(window as unknown as { __x: unknown }).__x = { flip: () => (xFail.on = true), heal: () => (xFail.on = false) };
const told: string[] = [];
const closed: string[] = [];
const notes: string[] = [];
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
const refuse = () => new Response("Home's stage answers only from the Mac — your click was not sent. Try again when the Mac is reachable.", { status: 503 });
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  const p = url.pathname.replace(/^.*\/api/, "");
  const method = init?.method ?? "GET";
  if (X === "slow") await wait(8000);
  if (xFail.on && X === "down") throw new TypeError("Load failed");
  if (xFail.on && (X === "f500" || X === "flaky") && (p === "/push/feed" || p === "/home/feed" || p === "/jobs")) return new Response("boom", { status: 500 });
  if (xFail.on && X === "flaky") throw new TypeError("Load failed");
  if (xPush && p === "/push/feed") return json({ rows: xPush });
  if (xFeed && p === "/home/feed") return json({ rows: xFeed, seen_at: new Date(ago(300)).toISOString(), as_of: ago(1), home: { project: "home", chat: "h-today" } });
  if (X === "crowded" && p === "/running") return json({ chats: Array.from({ length: 12 }, (_, i) => ({ chat: `r${i}`, title: i === 1 ? X_LONG : `Running chat ${i}`, since: ago(i * 9 + 1), waiting: i % 3 })), contexts: {} });
  if (p === "/home/seen" && method === "POST") return json({ seen_at: new Date().toISOString() });
  if (p === "/home/today") return json({ points: 0.3, cap: 5, week: 41, five_hour: 12, stopped: null });
  if (p === "/home/feed" && (real || empty)) return json({ rows: real ? [...real.feed].reverse() : [], seen_at: real ? real.seen_at : null, as_of: ago(1), home: { project: "home", chat: empty ? null : "h-today" } });
  if (p === "/home/held" && real) return json({ blockers: real.blockers.filter((b) => b.fields?.default === "held").map((b) => ({ project: "ns", project_name: "Nightshift (value generalization)", id: b.id, item: null, question: b.question })) });
  if ((real || empty) && p === "/home/scan") return json({ scan: null });
  if ((real || empty) && p === "/push/feed") return json({ rows: [] });
  if ((real || empty) && p === "/home/tasks") return json([]);
  if ((real || empty) && p === "/home/steps") return json([]);
  if (empty && p === "/home/sources") return json([]);
  if (p === "/home/feed") return json({ rows: [
    { at: new Date(ago(50)).toISOString(), kind: "done", label: null, chat: null, project: "Nightloom", line: "Night run finished — 2 fixes merged, CI passed" },
    { at: new Date(ago(90)).toISOString(), kind: "done", label: "Weekly backup", chat: null, project: null, line: "Weekly backup ran on time" },
  ], seen_at: new Date(ago(120)).toISOString(), as_of: ago(1), home: { project: "home", chat: "h-today" } });
  // Item 947: skip947=1 — a skipped scan's code-only page exactly as the host writes it (guard.rs skipped_scan_page),
  // with the reading cited in its words; skip947=old is yesterday's page (today:false).
  if (p === "/home/scan" && q.get("skip947")) {
    const why = "the weekly window was at 91% at 7:55 AM (Claude Code's usage cache)";
    const text = `Skipped: ${why}\n\nThis page is the facts alone, collected in code — no model read them.\n\n- Needs you: 2 held blockers\n- Calendar: 9:00 AM stand-up\n- Reminders: 1 overdue`;
    return json({ scan: { date: "2026-11-25", text, ran_at: ago(30), today: q.get("skip947") !== "old", skipped: why } });
  }
  if (p === "/home/scan") return json({ scan: { date: "2026-11-19", text: SCAN, ran_at: ago(240), today: true, skipped: null } });
  if (p === "/home/held") return json({ blockers: [] });
  if (p === "/home/routes") return json({ cards: [], held: [], started: [] });
  // Item 873: the Mac's apps, so the phone's Home on this Mac shows their marks.
  if (p === "/home/sources") return json([
    { id: "messages", name: "Messages", status: "allowed", on: true, why: "Home reads unread messages; it never replies.", settings_url: "" },
    { id: "reminders", name: "Reminders", status: "allowed", on: true, why: "Home reads due and overdue reminders.", settings_url: "" },
    { id: "calendar", name: "Calendar", status: "not_asked", on: false, why: "Not asked yet.", settings_url: "" },
    { id: "contacts", name: "Contacts", status: "denied", on: false, why: "You turned it down in System Settings.", settings_url: "" },
  ]);
  if (p === "/push/feed") return json({ rows: [{ what: "question", chat: "h-today", label: "Home", project: "home", at: ago(5) }] });
  if (p === "/jobs") return json({ jobs: [], now: new Date().toISOString() });
  if (p === "/running") return json({ chats: [], contexts: {} });
  if (p === "/home/steps") return json([
    { event: "user_message", text: "merge round T and build it", at: ago(30) },
    { event: "assistant_message", at: ago(29), model: "m", stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 }, blocks: [{ type: "tool_use", id: "1", name: "mcp__nightloom__start_chat", input: { project: "Nightloom" } }, { type: "tool_use", id: "2", name: "mcp__nightloom__update_task", input: { task: "Merge round T" } }, { type: "text", text: "Started the merge in a Nightloom chat; I will tell you when the build is ready." }] },
  ]);
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
  handledKept();
  applyLook(q.get("classic") === "1" ? "classic" : "filament");
  if (q.get("light") === "1") document.documentElement.dataset.scheme = "light"; // item 947
  const TAB: Record<string, string> = { brief: "brief", timeline: "task:moving-the-review", todo: "task:working-your-list", triage: "task:sorting-what-arrived", browse: "task:renewing-the-permit", run: "task:merge-round-t", research: "task:cache-pricing" };
  Object.assign(kept, { focus: TAB[s] ?? "watch", strip: "open", stripFor: "", ui: {} });
  // p872=1 (item 872): one tab waiting "ready →", a done task folded away ("1 done"), Home's steps open on the phone.
  if (q.get("p872") === "1") {
    const ids = ["task:moving-the-review", "task:working-your-list", "task:sorting-what-arrived", "task:renewing-the-permit", "task:merge-round-t", "task:cache-pricing"];
    const r = homeTasks.find((t) => t.id === "cache-pricing");
    if (r) r.state = "done";
    kept.ui["stage:focus"] = { follow: true, split: false, primed: true, ready: ["task:renewing-the-permit"], seen: Object.fromEntries(ids.map((i) => [i, 9])), doneSeen: { "task:cache-pricing": Date.now() - 300_000 }, folded: ["task:cache-pricing"] };
    kept.ui["phone:steps"] = { open: true };
  }
  // runctl=1 (item 872): Run after Stop now (its chat stopped, Resume shown) with a done step open (Run this step again).
  if (q.get("runctl") === "1") kept.ui["task:merge-round-t"] = { stop: false, halted: true, open: "r:merge", again: ["r:merge"] };
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
  // click946=1 (items 944–946 review): the Handled button's tap test on the phone — open, a row's ✓, Mark all seen,
  // shut and open again (kept). Read off the caption as `h946=PASS` or `h946=FAIL(<which>)`.
  let h946 = "";
  if (q.get("click946") === "1") {
    const fails: string[] = [];
    const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
    const n = () => Number(($(".h-hn")?.textContent ?? "0").replace("+", "")) || 0;
    const wasOpen = !!$(".h-handled");
    if (!wasOpen) $("[data-home-handled]")?.click();
    await wait(300);
    if (!$(".h-handled")) fails.push("open");
    const u0 = n();
    const rows0 = document.querySelectorAll(".h-hrow").length;
    $(".h-hseen")?.click();
    await wait(200);
    if (n() !== u0 - 1) fails.push(`rowcheck(${n()})`);
    if (document.querySelectorAll(".h-hrow").length !== rows0) fails.push("rowcheck-dropped");
    const kept946 = localStorage.getItem("nightloom.remote.home") ?? "";
    if (!/"handledOpen":true/.test(kept946) || !/"marked":\{"/.test(kept946)) fails.push("notkept");
    const all = [...document.querySelectorAll<HTMLButtonElement>(".h-hhead button")].find((b) => /Mark all seen/.test(b.textContent ?? ""));
    all?.click();
    await wait(400);
    if ($(".h-hn")) fails.push(`markall(${n()})`);
    if (document.querySelectorAll(".h-hrow").length !== rows0) fails.push("markall-dropped");
    $("[data-home-handled]")?.click();
    await wait(200);
    if ($(".h-handled")) fails.push("shut");
    $("[data-home-handled]")?.click();
    await wait(300);
    if (!$(".h-handled")) fails.push("reopen");
    h946 = ` h946=${fails.length ? `FAIL(${fails.join(",")})` : "PASS"} u0=${u0} rows=${rows0}${wasOpen ? " was-open" : ""}`;
  }
  // at=sources (item 873): the page scrolled to Home on this Mac, so the shot shows the Mac's apps and their marks.
  if (q.get("at") === "sources") {
    const sec = document.querySelector<HTMLElement>('[data-home-section="sources"]');
    const box = document.querySelector<HTMLElement>(".home");
    if (sec && box) box.scrollTop = sec.offsetTop - 80;
    await wait(200);
  }
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
    `845p s=${s}${away ? " away" : ""} tokens=${(window as unknown as { __tokens: number }).__tokens} stage=${st ? `${Math.round(st.getBoundingClientRect().width)}w ${st.className.replace(/svelte-\S+/g, "").replace(/\s+/g, " ").trim()}` : "MISSING"} tabs=${[...document.querySelectorAll(".h9-tab .tn")].map((n) => n.textContent).join("|")} on=${document.querySelector(".h9-tab.on .tn")?.textContent ?? "-"} sections=${document.querySelectorAll("[data-home-section]").length} tell=${document.querySelector("[data-home-tell]") ? "yes" : "no"} cut=${bad.length}${bad.length ? ` (${bad.slice(0, 4).join(", ")})` : ""} sideways=${wide} out=${out.length}${out.length ? ` (${out.slice(0, 4).join(", ")})` : ""}${piles ? ` piles=${piles}` : ""}${restart}${h946} vw${innerWidth}`,
  );
}
// The page is folded into one file with this script in <head>: wait for the body.
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void run());
else void run();
