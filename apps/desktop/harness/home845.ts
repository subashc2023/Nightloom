// Item 845 — see home845.html. The real App on the Home project over a stubbed backend, held for bin/snap.
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

const q = new URLSearchParams((window as unknown as { __h9q?: string }).__h9q ?? location.search);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const s = q.get("s") ?? "new";

const home = { id: "home", name: "Home", root: "/Users/you/.nightloom/home", notes_dir: "/Users/you/.nightloom/home/notes", chats: 12, notes: 5, exists: true, source: "nightloom:home" };
const projects = [home, { id: "nl", name: "Nightloom", root: "/Users/you/code/nightloom", notes_dir: "/Users/you/code/nightloom/.agents/notes", chats: 48, notes: 21, exists: true }];
const sessions = [{ id: "h-today", title: "Wednesday, November 18", mode: "normal", kind: "chat", modified: ago(1) }];
const SCAN = "Morning scan — write today's Home page.";
const page = "Three things need you today; the rest is handled.\n\n## Needs you\n- The landlord's lease question — a reply is due Friday.\n- Mom asked about Saturday.\n- The round-6 pick is waiting.\n\n## Today\n- 9:00 AM stand-up\n- 3:30 PM design review (moved from 2:00 PM)\n\n## Handled overnight\n1. The night run merged two fixes; CI passed.\n2. Filed one receipt.\n\n## Projects\n- Nightloom: build 212d1d4f installed.\n- nightshift-code: 4 items shipped, 1 held blocker.";
const scan = [
  { event: "user_message", text: `${SCAN}\nfeed: 6 rows\nprojects: 2\ncalendar: 2 events\nmail: 4 new`, at: ago(240) },
  { event: "assistant_message", model: "claude-opus-5-5", blocks: [{ type: "tool_use", id: "t1", name: "mcp__claude_ai_Gmail__search_threads", input: { query: "newer_than:1d" } }, { type: "tool_use", id: "t2", name: "mcp__claude_ai_Google_Calendar__list_events", input: { description: "today's events" } }, { type: "text", text: page }], stop_reason: "end_turn", usage: { input_tokens: 9200, output_tokens: 420 }, at: ago(239) },
];
const talk = [
  { event: "user_message", text: "what time is the review now?", at: ago(30) },
  { event: "assistant_message", model: "claude-opus-5-5", blocks: [{ type: "tool_use", id: "t3", name: "chat_status", input: {} }, { type: "text", text: "Design review is at 3:30 PM now — Priya moved it from 2:00 PM. Nothing else on your calendar clashes." }], stop_reason: "end_turn", usage: { input_tokens: 4200, output_tokens: 90 }, at: ago(30) },
];
const events = s === "brief" ? scan : [...scan, ...talk];
const feed = [
  { at: ago(50), kind: "done", label: null, chat: null, project: "Nightloom", line: "Night run finished — 2 fixes merged, CI passed" },
  { at: ago(90), kind: "done", label: "Weekly backup", chat: null, project: null, line: "Weekly backup ran on time" },
  { at: ago(200), kind: "done", label: null, chat: null, project: "nightshift-code", line: "Research on cache pricing finished — 1 page" },
];
const reach = { checked_at: ago(12), error: null, locals: [], accounts: [
  { connector: "claude.ai Gmail", service: "Gmail", kind: "mail", address: "you@example.com", nth: null, status: "connected", on: true, claude_ai: true, in_scan: true },
  { connector: "claude.ai Google Calendar", service: "Google Calendar", kind: "calendar", address: "you@example.com", nth: null, status: "connected", on: true, claude_ai: true, in_scan: true },
  { connector: "claude.ai Google Drive", service: "Google Drive", kind: "files", address: null, nth: null, status: "needs_sign_in", on: true, claude_ai: true, in_scan: false },
] };
const macSources = [
  { id: "messages", name: "Messages", status: "allowed", on: true, why: "Home reads unread messages; it never replies.", settings_url: "" },
  { id: "reminders", name: "Reminders", status: "allowed", on: true, why: "Home reads due and overdue reminders.", settings_url: "" },
  { id: "calendar", name: "Calendar app", status: "not_asked", on: false, why: "Not asked yet.", settings_url: "" },
];

// Batch 1: three tasks as Home's update_task would write them (the shapes in tasks.rs's description).
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
const task = (id: string, view: string, name: string, doing: string, needs: number, data: unknown, why = "") => ({ id, view, name, doing, step: 2, of: 5, state: "live", needs, why, data, started_at: ago(20), updated_at: ago(1) });
const homeTasks = [
  task("moving-the-review", "timeline", "Moving the design review", "Checking four calendars for today", 3, {
    day: "Wednesday, November 18", date: today,
    events: [
      { id: "stand", title: "Stand-up", start: "9:00", end: "9:30", detail: { With: "The Nightloom team (5)", Home: "Left as it is" } },
      { id: "lunch", title: "Lunch · Dana", start: "12:00", end: "13:00", detail: { Where: "Tender Greens, booked by Dana" } },
      { id: "gym", title: "Gym", start: "17:30", end: "18:30" },
    ],
    changes: [
      { id: "review", kind: "move", title: "Design review", start: "15:30", end: "16:30", was: "14:00", why: "Priya asked to move it", detail: { "Who asked": "Priya Raman, 10:38 AM", "Free / busy": "Priya, Dana and Marcus are free 3:30–4:30 PM", Undo: "Until you accept, nothing is written" } },
      { id: "focus", kind: "add", title: "Focus: item 809", start: "10:00", end: "11:30", why: "your longest free stretch before lunch" },
      { id: "priya", kind: "pick", title: "30 min with Priya", start: "16:30", end: "17:00", slots: ["11:30", "14:00", "16:30"], why: "you asked on Monday", yours: true },
    ],
  }, "find 30 min with Priya this week"),
  task("working-your-list", "todo", "Working your to-do list", "Renewing the parking permit on the city's site", 0, {
    items: [
      { id: "permit", text: "Renew the parking permit", who: "home", state: "doing", note: "overdue · city site", steps: [{ text: "Open the city's renewal page", done: true }, { text: "Fill permit RP-204418 and plate", done: true }, { text: "Hold for your OK to pay $84.00", done: false }, { text: "File the receipt", done: false }] },
      { id: "lease", text: "Decide on the lease renewal", who: "you", state: "open", note: "needs you · due Friday" },
      { id: "slides", text: "Slides for Thursday's review", who: "you", state: "open", note: "you · 40% drafted" },
      { id: "gift", text: "Order Mom's birthday gift", who: "home", state: "open", note: "Nov 24" },
      { id: "dentist", text: "Book the dentist cleaning", who: "home", state: "done", result: "Thu 4:15 PM · on your calendar", detail: { "What Home did": "Booked on the office's site; no payment" } },
    ],
  }),
  task("sorting-what-arrived", "triage", "Sorting what arrived", "Reading Mom's message", 2, {
    cards: [
      { id: "lease", from: "Landlord", title: "Lease renewal — reply by Friday", source: "gmail", pile: "needs", verdict: "A decision only you can make", question: "Renew for 12 months at $2,340, or go month to month at $2,520?", options: ["Renew 12 months", "Month to month"], todo: "Decide on the lease renewal" },
      { id: "mom", from: "Mom", title: "“Are you coming Saturday?”", source: "messages", pile: "needs", verdict: "A yes or no from you", question: "“Are you coming Saturday?” — your calendar is free after 2:00 PM.", options: ["Yes, after 2", "Can't make it"] },
      { id: "stripe", from: "Stripe", title: "Receipt #2291 · $49.00", source: "gmail", pile: "handled", verdict: "Filed under Taxes 2026" },
      { id: "ci", from: "CI", title: "nightshift · run 4183 passed", source: "ci", pile: "handled", verdict: "Told the merge chat" },
      { id: "news", from: "Stratechery", title: "This week's update", source: "gmail", pile: "later", verdict: "Reading, not action — tonight" },
      { id: "delta", from: "Delta", title: "Refund 0062381 approved", source: "gmail", pile: "inbox", reading: true },
      { id: "promo", from: "Promotions", title: "4 newsletters and offers", source: "gmail", pile: "inbox" },
    ],
  }),
];
const told: string[] = [];

(window as unknown as { __stub: (c: string, a?: Record<string, unknown>) => Promise<unknown> }).__stub = async (cmd, a) => {
  switch (cmd) {
    case "list_models": return ["claude-opus-5-5", "claude-sonnet-5"];
    case "list_projects": return projects;
    case "list_sessions": return sessions;
    case "open_session": return events;
    case "providers": return [{ kind: "anthropic", available: true, default_model: "claude-opus-5-5", key_source: "stored" }];
    case "schedule_probe": return { due_ms: [], limit_ms: null };
    case "home_info": return { project_id: "home", chat_id: s === "new" ? null : "h-today", folder: home.root, brief: "", scan_words: "Every day at 8:00 AM", scan_job_id: null };
    case "home_feed": return { rows: feed, seen_at: ago(120) };
    case "home_reach": case "home_reach_check": return reach;
    case "home_sources": return macSources;
    case "home_routes": return { cards: [], held: [], started: [] };
    case "named_files": case "for_you_files": case "search_backends": case "centre_proposals": case "centre_dream_commits": case "list_notes": case "turn_usage": case "list_threads": case "nightshift_projects": case "tidy_memory": case "tidy_threads":
      return [];
    case "home_tasks": return homeTasks;
    case "home_task_event": told.push(String((a as { line?: string })?.line ?? "")); return null;
    case "home_task_close": return null;
    default: return null;
  }
};

async function run() {
  // bin/snap's hidden window runs no animation: draw every arrival at its end state.
  document.head.insertAdjacentHTML("beforeend", "<style>*,*::before,*::after{animation:none!important;transition:none!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important}.lk-veil,.lk-scan,.toasts{display:none!important}</style>");
  localStorage.clear();
  sessionStorage.clear();
  const TASK_TAB: Record<string, string> = { timeline: "task:moving-the-review", todo: "task:working-your-list", triage: "task:sorting-what-arrived" };
  Object.assign(kept, { focus: s === "chat" ? "chat" : s === "brief" ? "brief" : TASK_TAB[s] ?? "watch", strip: "open", stripFor: "", ui: {} });
  if (q.get("classic") === "1") setLayout("classic");
  let root = mount(App, { target: document.getElementById("app")! });
  flushSync();
  await wait(350);
  app.projects = projects as unknown as typeof app.projects;
  app.project = home as unknown as typeof app.project;
  app.sessions = (s === "new" ? [] : sessions) as unknown as typeof app.sessions;
  const connection = { provider: "anthropic", model: "claude-opus-5-5", thinking: "default", tools: true, contextLimit: 1_000_000, price: null, mcp: [], reviewers: [], workspace: home.root, search: null, knowledge: null, engine: "claude-code", agent: null } as unknown as typeof app.connection;
  app.connection = connection;
  await tick();
  if (s !== "new") await openSession("h-today");
  await tick();
  await wait(250);
  if (!app.connection) app.connection = connection;
  railFold.folded = true;
  await wait(600);
  // restart=1: his clicks in the view, the stage saved, the App torn down, the stage read back from storage only, and
  // the App mounted again — what the shot then shows is what survived.
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
      document.querySelector<HTMLElement>(".nd")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }
    flushSync();
    keep();
    const saved = localStorage.getItem(STAGE_KEY) ?? "";
    unmount(root);
    Object.assign(kept, readKept(saved));
    root = mount(App, { target: document.getElementById("app")! });
    flushSync();
    await wait(300);
    app.project = home as unknown as typeof app.project;
    await openSession("h-today");
    await wait(900);
    restart = ` restart=${saved.length}B told=${told.length}`;
  }
  void root;
  // What a script can read off the shot's page: the stage is there, and nothing on it is cut off or scrolls sideways.
  const stage = document.querySelector<HTMLElement>("[data-home-stage]");
  const bad: string[] = [];
  for (const el of stage?.querySelectorAll<HTMLElement>("*") ?? []) {
    if (el instanceof SVGElement || el.closest(".h9-chat")) continue;
    const cs = getComputedStyle(el);
    const dx = el.scrollWidth - el.clientWidth;
    if (dx > 1 && /(hidden|clip|auto|scroll)/.test(cs.overflowX) && !/h9-tabs|h9-doing|b-counts|b-count/.test(el.className)) bad.push(`${el.className.split(" ")[0]} +${dx}`);
  }
  // The ghost check (845 batch 1): how many views are in the body, and the page's animations, now and 1.5 s later.
  const ghost = () => `${document.querySelectorAll(".h9-view").length}[${document.getAnimations().map((a) => `${a.playState}@${Math.round(Number(a.currentTime ?? -1))}`).join(",")}]`;
  const g0 = ghost();
  await wait(1500);
  const g1 = ghost();
  const r = stage?.getBoundingClientRect();
  document.title = `845 s=${s} stage=${r ? `${Math.round(r.width)}x${Math.round(r.height)}` : "MISSING"} tabs=${[...document.querySelectorAll(".h9-tab .tn")].map((n) => n.textContent).join("|")} views=${g0}→${g1} welcome=${document.querySelector(".welcome") ? "yes" : "no"} composer=${document.querySelector(".composer") ? "yes" : "no"} cut=${bad.length}${bad.length ? ` (${bad.slice(0, 4).join(", ")})` : ""}${restart} cq=${(() => { const v = document.querySelector<HTMLElement>(".h9-view"); const wd = document.querySelector<HTMLElement>(".h9-wide"); return `${v ? Math.round(v.getBoundingClientRect().width) : 0}/${wd ? getComputedStyle(wd).display : "-"}/vw${innerWidth}/dpr${devicePixelRatio}`; })()}`;
  if (q.get("cap") === "1") (window as unknown as { __capset: (m: string) => void }).__capset(document.title);
}
if (document.readyState === "loading") addEventListener("DOMContentLoaded", () => void run());
else void run();
