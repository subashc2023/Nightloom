// Item 947 (views slice) — see views947.html. The real App on the Home project over a stubbed backend whose data can
// grow while the page runs, for two checks read off the title (bin/snap):
//   mode=state&v=<view>: his clicks in the view (a row opened, a field typed in, every scrolling box scrolled), then
//     the view read four ways — as he left it, after a tab switch away and back (real tab clicks), after leaving Home
//     for another project and coming back, and after a real unmount and mount of the App from storage alone (an app
//     restart). `state=PASS` or `state=FAIL(<which>:<what differs>)`.
//   mode=grow: a first run — nothing at all — then one thing arrives at a time (a handled row, a source, a question,
//     a task, a second task, the Mac's apps, the scan). After each: which sections are drawn, the tabs, the focus,
//     and whether anything is cut or off the stage; then a restart. `grow=PASS|FAIL(<step>:<why>)` and the steps.
// classic=1 for the Classic layout. Not shipped.
import "@fontsource-variable/newsreader/wght.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "../src/app.css";
import "../src/composerControls.css";
import "../src/composerRow.css";
import { mount, unmount, flushSync, tick } from "svelte";
import App from "../src/App.svelte";
import { app, openSession } from "../src/lib/state.svelte";
import { railFold } from "../src/lib/railFold.svelte";
import { setLayout } from "../src/lib/layout.svelte";
import { stage as kept, keep, readKept, STAGE_KEY } from "../src/lib/homeStage/stageState.svelte";
import { needs as board, refreshBoard } from "../src/lib/needsBoard.svelte";
import { refreshHome, refreshReach, refreshSources } from "../src/lib/home.svelte";
import { refreshTasks } from "../src/lib/homeStage/tasks.svelte";
import { homeTasks } from "./home845/fixtures";

const q = new URLSearchParams((window as unknown as { __h9q?: string }).__h9q ?? location.search);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const mode = q.get("mode") ?? "state";
const v = q.get("v") ?? "watch";
const grow = mode === "grow";

const home = { id: "home", name: "Home", root: "/Users/you/.nightloom/home", notes_dir: "/Users/you/.nightloom/home/notes", chats: 12, notes: 5, exists: true, source: "nightloom:home" };
const projects = [home, { id: "nl", name: "Nightloom", root: "/Users/you/code/nightloom", notes_dir: "/Users/you/code/nightloom/.agents/notes", chats: 48, notes: 21, exists: true }];
const sessions = [{ id: "h-today", title: "Wednesday, November 18", mode: "normal", kind: "chat", modified: ago(1) }];
const SCAN = "Morning scan — write today's Home page.";
const longPage = Array.from({ length: 30 }, (_, i) => `- Line ${i + 1} of the brief: something Home read overnight and wrote down for you.`).join("\n");
const page = `Three things need you today; the rest is handled.\n\n## Needs you\n- The landlord's lease question — a reply is due Friday.\n- Mom asked about Saturday.\n\n## Today\n- 9:00 AM stand-up\n- 3:30 PM design review\n\n## Handled overnight\n${longPage}`;
const scan = [
  { event: "user_message", text: `${SCAN}\nfeed: 6 rows`, at: ago(240) },
  { event: "assistant_message", model: "claude-opus-5-5", blocks: [{ type: "text", text: page }], stop_reason: "end_turn", usage: { input_tokens: 9200, output_tokens: 420 }, at: ago(239) },
];
const talk = Array.from({ length: 12 }, (_, i) => [
  { event: "user_message", text: `question ${i + 1}: what time is the review now?`, at: ago(60 - i * 2) },
  { event: "assistant_message", model: "claude-opus-5-5", blocks: [{ type: "text", text: `Answer ${i + 1}. Design review is at 3:30 PM now — Priya moved it from 2:00 PM.\n\n${"Nothing else on your calendar clashes. ".repeat(6)}` }], stop_reason: "end_turn", usage: { input_tokens: 4200, output_tokens: 90 }, at: ago(60 - i * 2) },
]).flat();

// What the stub serves; grow mode starts with nothing and the steps push into it.
const fullFeed = [
  { at: ago(50), kind: "done", label: "Merge round T and build it", chat: "c1", project: "nl", line: "Finished" },
  { at: ago(70), kind: "question", label: "ICS 51 Exam 3 study plan coverage", chat: "c2", project: "nl", line: "Has a question for you" },
  { at: ago(90), kind: "job_done", label: "Weekly backup", chat: null, project: null, line: "Weekly backup ran on time" },
  ...Array.from({ length: 30 }, (_, i) => ({ at: ago(300 + i * 20), kind: "done", label: `Fixture chat ${i + 1}`, chat: `x${i}`, project: "nl", line: "Finished" })),
];
const acct = (service: string, kind: string, nth: number | null, extra: Record<string, unknown> = {}) => ({ connector: `claude.ai ${service}${nth ? ` ${nth}` : ""}`, service, kind, address: null, nth, status: "connected", on: true, claude_ai: true, in_scan: true, ...extra });
const fullAccounts = [
  acct("Gmail", "mail", 1), acct("Gmail", "mail", 2), acct("Gmail", "mail", 3),
  acct("Google Calendar", "calendar", 1), acct("Google Calendar", "calendar", 2, { status: "needs_sign_in", in_scan: false }), acct("Google Calendar", "calendar", 3),
  acct("Claude Docs", "files", null, { in_scan: false }), acct("Google Drive", "files", null, { status: "needs_sign_in", in_scan: false }),
  acct("Google Slides", "files", null, { in_scan: false }), acct("Google Sheets", "files", null, { in_scan: false, on: false }),
  acct("Acme Tracker", "other", null, { status: "failed", in_scan: false, claude_ai: false }),
];
const fullMac = [
  { id: "messages", name: "Messages", status: "allowed", on: true, why: "Home reads unread messages; it never replies.", settings_url: "" },
  { id: "reminders", name: "Reminders", status: "allowed", on: true, why: "Home reads due and overdue reminders.", settings_url: "" },
  { id: "contacts", name: "Contacts", status: "denied", on: false, why: "You turned it down in System Settings.", settings_url: "" },
];
const allTasks = JSON.parse(JSON.stringify(homeTasks)) as { id: string; view: string }[];
const G = {
  feed: grow ? ([] as typeof fullFeed) : fullFeed,
  accounts: grow ? ([] as typeof fullAccounts) : fullAccounts,
  mac: grow ? ([] as typeof fullMac) : fullMac,
  tasks: grow ? ([] as typeof allTasks) : allTasks,
  events: grow ? ([] as unknown[]) : v === "brief" ? scan : [...scan, ...talk],
};
const told: string[] = [];

(window as unknown as { __stub: (c: string, a?: Record<string, unknown>) => Promise<unknown> }).__stub = async (cmd, a) => {
  switch (cmd) {
    case "list_models": return ["claude-opus-5-5", "claude-sonnet-5"];
    case "list_projects": return projects;
    case "list_sessions": return G.events.length ? sessions : [];
    case "open_session": return G.events;
    case "providers": return [{ kind: "anthropic", available: true, default_model: "claude-opus-5-5", key_source: "stored" }];
    case "schedule_probe": return { due_ms: [], limit_ms: null };
    case "home_info": return { project_id: "home", chat_id: G.events.length ? "h-today" : null, folder: home.root, brief: "", scan_words: "Every day at 8:00 AM", scan_job_id: null };
    case "home_feed": return { rows: G.feed, seen_at: ago(120) };
    case "home_mark_seen": return new Date().toISOString();
    case "nightshift_projects": return [];
    case "nightshift_blockers": return { blockers: [] };
    case "nightshift_items": return { items: [] };
    case "home_reach": case "home_reach_check": return { checked_at: ago(12), error: null, locals: [], accounts: G.accounts };
    case "home_reach_check_one": return { checked_at: ago(0), error: null, locals: [], accounts: G.accounts };
    case "list_notes": return [];
    case "save_note": return { name: (a as { name?: string })?.name, bytes: 1, modified: ago(0), summary: "", kind: "markdown" };
    case "claude_browser_status": return null;
    case "home_sources": return G.mac;
    case "home_routes": return { cards: [], held: [], started: [] };
    case "list_proposals": case "named_files": case "for_you_files": case "search_backends": case "centre_proposals": case "centre_dream_commits": case "turn_usage": case "list_threads": case "tidy_memory": case "tidy_threads":
      return [];
    case "home_tasks": return G.tasks;
    case "home_task_event": told.push(String((a as { line?: string })?.line ?? "")); return null;
    case "home_task_close": return null;
    case "home_stage_focus": return null;
    case "door_started": return {};
    default: return null;
  }
};

const errs: string[] = [];
addEventListener("error", (e) => errs.push(`${(e as ErrorEvent).message} ${String((e as ErrorEvent).error?.stack ?? "").slice(0, 200)}`));
addEventListener("unhandledrejection", (e) => errs.push(String((e as PromiseRejectionEvent).reason)));
const ce = console.error.bind(console);
console.error = (...m: unknown[]) => (errs.push(m.map(String).join(" ").slice(0, 120)), ce(...m));

const $ = <T extends HTMLElement = HTMLElement>(sel: string, r: ParentNode = document) => r.querySelector<T>(sel);
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, r: ParentNode = document) => [...r.querySelectorAll<T>(sel)];
const cls = (e: Element) => (e.getAttribute("class") ?? e.tagName).split(" ")[0];
const scrollers = (r: ParentNode) => $$<HTMLElement>("*", r).filter((e) => e.scrollHeight > e.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(e).overflowY));
// Where each scrolling box sits: named by its class and its place among the view's scrollers.
// Home's steps (sp-list) follow the newest step by design, so their place is not compared.
const scrollSig = (r: ParentNode) => scrollers(r).filter((e) => !e.classList.contains("sp-list")).map((e, i) => `${i}.${cls(e)}:${Math.round(e.scrollTop)}`);

let root: ReturnType<typeof mount>;
const TASK_TAB: Record<string, string> = { timeline: "task:moving-the-review", todo: "task:working-your-list", triage: "task:sorting-what-arrived", browse: "task:renewing-the-permit", run: "task:merge-round-t", research: "task:cache-pricing" };

async function openHomeProject() {
  app.projects = projects as unknown as typeof app.projects;
  app.project = home as unknown as typeof app.project;
  app.sessions = (G.events.length ? sessions : []) as unknown as typeof app.sessions;
  app.connection = connection;
  await tick();
  if (G.events.length) await openSession("h-today").catch((e) => errs.push(`open:${String(e?.stack ?? e).slice(0, 300)}`));
  await tick();
  await wait(250);
  if (!app.connection) app.connection = connection;
  // The App's own start-up reads may land after this (a loaded machine): set again until Home stays.
  for (let i = 0; i < 20 && (app.project?.id !== "home" || !document.querySelector("[data-home-stage]")); i++) {
    await wait(400);
    app.projects = projects as unknown as typeof app.projects;
    if (app.project?.id !== "home") app.project = home as unknown as typeof app.project;
    if (!app.connection) app.connection = connection;
    if (G.events.length && app.activeSessionId !== "h-today") await openSession("h-today").catch((e) => errs.push(`open2:${String(e?.stack ?? e).slice(0, 300)}`));
    document.title = `947 loop ${i} p=${app.project?.id} a=${app.activeSessionId} errs=${errs.join(" || ").slice(0, 600)}`;
    flushSync();
  }
}
const connection = { provider: "anthropic", model: "claude-opus-5-5", thinking: "default", tools: true, contextLimit: 1_000_000, price: null, mcp: [], reviewers: [], workspace: home.root, search: null, knowledge: null, engine: "claude-code", agent: null } as unknown as typeof app.connection;

/** The App torn down and mounted again from what storage holds — an app restart, as far as the page can make one. */
async function restart() {
  flushSync();
  keep();
  const saved = localStorage.getItem(STAGE_KEY) ?? "";
  unmount(root);
  await wait(100);
  for (const k of Object.keys(kept)) delete (kept as Record<string, unknown>)[k];
  Object.assign(kept, readKept(saved));
  root = mount(App, { target: document.getElementById("app")! });
  flushSync();
  await wait(350);
  await openHomeProject();
  await wait(1200);
  flushSync();
}

/** What is cut or off the stage's edges (as home845's title check). */
function layout(): string {
  const st = $("[data-home-stage]");
  if (!st) return "nostage";
  const sr = st.getBoundingClientRect();
  const bad: string[] = [];
  for (const el of $$("*", st)) {
    if (el instanceof SVGElement || el.closest(".h9-chat")) continue;
    const cs = getComputedStyle(el);
    if (el.scrollWidth - el.clientWidth > 1 && /(hidden|clip|auto|scroll)/.test(cs.overflowX) && cs.textOverflow !== "ellipsis" && !/h9-tabs|h9-doing|b-counts|b-count/.test(el.className)) bad.push(`cut:${cls(el)}`);
    const er = el.getBoundingClientRect();
    if (!er.width || !er.height) continue;
    let p = el.parentElement;
    let inS = false;
    while (p && p !== st) {
      if (/(auto|scroll)/.test(getComputedStyle(p).overflowX)) (inS = true), (p = null);
      else p = p.parentElement;
    }
    if (!inS && Math.max(er.right - sr.right, sr.left - er.left) > 1) bad.push(`out:${cls(el)}`);
  }
  return bad.length ? [...new Set(bad)].slice(0, 5).join(",") : "ok";
}

const banner = document.createElement("pre");
banner.style.cssText = "position:fixed;z-index:999999;left:0;bottom:0;right:0;margin:0;padding:6px;background:#000d;color:#6f6;font:12px monospace;white-space:pre-wrap;max-height:45vh;overflow:auto";
const say = (t: string) => ((banner.textContent = t), (document.title = `947 ${t}`));

async function stateCheck(): Promise<string> {
  // The last one: a view he left can stay drawn on its way out in a hidden window (845's ghost).
  const view = () => $$(".h9-view:not(.second)").at(-1) ?? null;
  const sig = () => {
    const w = view();
    if (!w) return { all: "NOVIEW" } as Record<string, string>;
    return {
      focus: kept.focus,
      open: String($$(".isopen", w).length),
      on: $$(".on,[aria-pressed=true],[aria-expanded=true]", w).map(cls).join(","),
      inputs: $$<HTMLInputElement>("input,textarea", w).map((e) => e.value).join("|"),
      scroll: scrollSig(w).join(","),
      text: String((w.textContent ?? "").replace(/\s+/g, " ").length),
      bag: JSON.stringify(kept.ui[`scroll:${kept.focus}`] ?? null),
    } as Record<string, string>;
  };
  const w = view();
  if (!w) return "state=FAIL(noview)";
  document.title = "947 step a-sig";
  const before0 = sig();
  // His clicks: the view's own first action, a row opened, a field typed in, every scroller scrolled.
  const click = (sel: string) => $(sel, w)?.click();
  if (v === "timeline") click(".t-chg .jc .jb.send");
  if (v === "todo") click(".d-box:not(.on)");
  if (v === "triage") click(".g-card:not(.isopen) .nd .h9-acts .jb.send");
  if (v === "browse") click(".h9-wide .h9-acts .jb.send");
  if (v === "research") click(".s-claim .jb");
  if (v === "watch") $$<HTMLElement>(".nd .h9-acts .jb", w)[0]?.click();
  document.title = "947 step a1-clicked";
  flushSync();
  await wait(150);
  document.title = "947 step a2-flushed";
  const row = $$(".h9-open:not(.isopen)", view()!).find((e) => !e.closest(".w-answer"));
  row?.click();
  document.title = "947 step a3-row " + cls(row ?? document.body);
  flushSync();
  await wait(150);
  document.title = "947 step a4-typing";
  for (const inp of $$<HTMLInputElement>("input:not([type=checkbox]):not([disabled]),textarea:not([disabled])", view()!)) {
    inp.value = "half-typed words";
    inp.dispatchEvent(new Event("input", { bubbles: true }));
  }
  (document.activeElement as HTMLElement | null)?.blur?.();
  flushSync();
  await wait(200);
  document.title = "947 step a5-scroll";
  // A hidden window fires no scroll events of its own: send the one his wheel would.
  for (const s of scrollers(view()!)) s.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 100 })), (s.scrollTop = Math.min(140, Math.round((s.scrollHeight - s.clientHeight) / 2))), s.dispatchEvent(new Event("scroll"));
  await wait(400);
  flushSync();
  document.title = "947 step b-acted";
  const sigs: Record<string, Record<string, string>> = { before: sig() };
  const acted = Object.keys(before0).filter((k) => before0[k] !== sigs.before[k]);
  // (1) a tab switch away and back, by his clicks on the tab row
  const tabs = () => $$<HTMLButtonElement>(".h9-tab:not(.h9-folded)");
  const mine = tabs().find((t) => t.classList.contains("on"));
  const tn = (t: Element) => t.querySelector(".tn")?.textContent ?? "";
  const name = mine ? tn(mine) : "";
  const other = tabs().find((t) => !t.classList.contains("on"));
  other?.click();
  await wait(500);
  flushSync();
  tabs().find((t) => tn(t) === name)?.click();
  await wait(700);
  flushSync();
  sigs.tab = sig();
  document.title = "947 step c-tab";
  // (2) leave Home for another project and come back
  const st0 = $("[data-home-stage]");
  app.project = projects[1] as unknown as typeof app.project;
  await wait(500);
  flushSync();
  const unmounted = !document.contains(st0);
  app.project = home as unknown as typeof app.project;
  await wait(2000);
  flushSync();
  sigs.leave = sig();
  document.title = "947 step d-leave";
  // (3) a real unmount and mount from storage alone
  await restart();
  sigs.restart = sig();
  const diffs: string[] = [];
  for (const k of ["tab", "leave", "restart"]) for (const f of Object.keys(sigs.before)) if (sigs[k][f] !== sigs.before[f]) diffs.push(`${k}.${f}[${sigs.before[f]} → ${sigs[k][f]}]`);
  return `state=${diffs.length ? `FAIL` : "PASS"} v=${v} acted=${acted.join("+") || "none"} leaveUnmounted=${unmounted} other=${other ? "yes" : "none"} layout=${layout()} errs=${errs.length}${errs.length ? `(${errs.slice(0, 2).join(";")})` : ""}\n${diffs.join("\n") || JSON.stringify(sigs.before)}`;
}

async function growCheck(): Promise<string> {
  const steps: string[] = [];
  const fails: string[] = [];
  const look = (name: string, want: { has?: string[]; not?: string[] } = {}) => {
    flushSync();
    const has = {
      calm: !!$(".w-calm"),
      bare: !!$(".w-watch.bare"),
      sources: $$(".h9-panel").some((p) => /Sources/.test(p.textContent ?? "")),
      needs: $$(".h9-panel").some((p) => /Needs you/.test($(".h9-ph,.h9-pt,h3,header", p)?.textContent ?? p.textContent ?? "")) && !!$(".w-needs"),
      steps: $$(".h9-panel").some((p) => /Home's steps/.test(p.textContent ?? "")),
      handled: !!$("[data-handled] .hm-btn"),
    } as Record<string, boolean>;
    const tabs = $$(".h9-tab .tn").map((n) => n.textContent).join("|");
    const lay = layout();
    const arrived = $$(".h9-arrive").map(cls).join(",");
    for (const h of want.has ?? []) if (!has[h]) fails.push(`${name}:missing-${h}`);
    for (const h of want.not ?? []) if (has[h]) fails.push(`${name}:unwanted-${h}`);
    if (lay !== "ok") fails.push(`${name}:${lay}`);
    steps.push(`${name}: ${Object.entries(has).filter(([, b]) => b).map(([k]) => k).join(",") || "-"} tabs=${tabs} focus=${kept.focus} arrive=[${arrived}] layout=${lay}`);
  };
  look("0-empty", { has: ["calm", "bare"], not: ["sources", "needs", "steps", "handled"] });
  // 1. Home handled something.
  G.feed.push(fullFeed[0]);
  await refreshHome();
  await wait(500);
  look("1-handled", { has: ["handled", "calm"], not: ["sources", "needs"] });
  // 2. One source is connected.
  G.accounts.push(fullAccounts[0]);
  await refreshReach();
  await wait(500);
  look("2-source", { has: ["sources", "calm"], not: ["needs", "bare"] });
  // 3. A chat asks him something.
  board.ended = [{ chat: "nl-1", name: "Pick the round-6 layout", project: "nl", projectName: "Nightloom", at: Date.now() - 60_000, failed: false, ask: { question: "Which layout for round 6 — the two-column one or the stacked one?", options: ["Two columns", "Stacked"] } }] as typeof board.ended;
  await refreshBoard(true);
  await wait(500);
  look("3-question", { has: ["sources", "needs"], not: ["calm"] });
  // 4. Home starts a task (he touched the page just now, so focus stays where he is).
  window.dispatchEvent(new PointerEvent("pointerdown"));
  G.tasks.push(allTasks.find((t) => t.view === "todo")!);
  await refreshTasks();
  await wait(1300);
  look("4-task");
  if (kept.focus !== "watch") fails.push(`4-task:focus-jumped(${kept.focus})`);
  // 5. A second task; three more sources; the Mac's apps.
  G.tasks.push(allTasks.find((t) => t.view === "timeline")!);
  G.accounts.push(...fullAccounts.slice(1, 6));
  G.mac.push(...fullMac);
  window.dispatchEvent(new PointerEvent("pointerdown"));
  await Promise.all([refreshTasks(), refreshReach(), refreshSources()]);
  await wait(1300);
  // A task he asked for (`why`) takes focus at once — by design (focus.ts, "You asked for it"); he clicks back to Watching.
  if (kept.focus !== "task:moving-the-review") fails.push(`5-more:asked-task-not-opened(${kept.focus})`);
  $$<HTMLButtonElement>(".h9-tab").find((t) => /Watching/.test(t.textContent ?? ""))?.click();
  await wait(800);
  look("5-more", { has: ["sources", "needs"] });
  // 6. The morning scan lands in Home's chat.
  G.events = scan;
  await openHomeProject();
  await wait(800);
  look("6-scan");
  // 7. Restart: everything comes back, nothing arrives again.
  const before = steps[steps.length - 1].replace(/^6-scan: /, "").replace(/arrive=\[[^\]]*\] /, "");
  await restart();
  look("7-restart");
  const after = steps[steps.length - 1].replace(/^7-restart: /, "").replace(/arrive=\[[^\]]*\] /, "");
  if (before !== after) fails.push(`7-restart:differs`);
  if ($$(".h9-arrive").length) fails.push("7-restart:arrived-again");
  return `grow=${fails.length ? `FAIL(${fails.join(";")})` : "PASS"} errs=${errs.length}${errs.length ? `(${errs.slice(0, 2).join(";")})` : ""}\n${steps.join("\n")}`;
}

async function run() {
  document.head.insertAdjacentHTML("beforeend", "<style>*,*::before,*::after{animation:none!important;transition:none!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important}.lk-veil,.lk-scan,.toasts{display:none!important}</style>");
  localStorage.clear();
  sessionStorage.clear();
  if (q.get("classic") === "1") setLayout("classic");
  root = mount(App, { target: document.getElementById("app")! });
  Object.assign(kept, { focus: v === "chat" ? "chat" : v === "brief" ? "brief" : TASK_TAB[v] ?? "watch", strip: "open", stripFor: "", ui: { "stage:focus": { follow: !!grow, split: false, primed: false, ready: [], seen: {} } } });
  flushSync();
  await wait(350);
  await openHomeProject();
  railFold.folded = true;
  if (!grow && v === "watch") {
    board.ended = [
      { chat: "asc-1", name: "Applications round closed — cut 162 to 40 by Friday", project: "nl", projectName: "Nightloom", at: Date.now() - 600_000, failed: false, ask: { question: "Should the first cut be by the rubric score alone, or should the essay pass come first?", options: ["Rubric first", "Essay pass first"] } },
      ...Array.from({ length: 8 }, (_, i) => ({ chat: `d-${i}`, name: `Finished chat ${i + 1}`, project: "nl", projectName: "Nightloom", at: Date.now() - 900_000 - i * 1000, failed: false, ask: null })),
    ] as typeof board.ended;
    await refreshBoard(true);
  }
  await wait(900);
  document.title = "947 step 0-opened " + errs.join("||").slice(0, 300);
  document.body.appendChild(banner);
  let out = "";
  try {
    out = grow ? await growCheck() : await stateCheck();
  } catch (e) {
    out = `threw(${String((e as Error)?.message ?? e)}) ${String((e as Error)?.stack ?? "").split("\n").slice(0, 3).join(" < ")}`;
  }
  say(out);
}
if (document.readyState === "loading") addEventListener("DOMContentLoaded", () => void run());
else void run();
