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
// Item 873: the feed as his reads — each row's label is its chat's title, its project an id the list names.
const feed = [
  { at: ago(50), kind: "done", label: "Merge round T and build it", chat: "c1", project: "nl", line: "Finished" },
  { at: ago(70), kind: "question", label: "ICS 51 Exam 3 study plan coverage", chat: "c2", project: "nl", line: "Has a question for you" },
  { at: ago(90), kind: "job_done", label: "Weekly backup", chat: null, project: null, line: "Weekly backup ran on time" },
  { at: ago(140), kind: "failed", label: "Lecture activities — answers check", chat: "c3", project: "nl", line: "Failed" },
  { at: ago(200), kind: "done", label: null, chat: null, project: "nightshift-code", line: "Research on cache pricing finished — 1 page" },
];
const acct = (service: string, kind: string, nth: number | null, extra: Record<string, unknown> = {}) => ({ connector: `claude.ai ${service}${nth ? ` ${nth}` : ""}`, service, kind, address: null, nth, status: "connected", on: true, claude_ai: true, in_scan: true, ...extra });
const reach = { checked_at: ago(12), error: null, locals: [], accounts: [
  acct("Gmail", "mail", 1), acct("Gmail", "mail", 2), acct("Gmail", "mail", 3),
  acct("Google Calendar", "calendar", 1), acct("Google Calendar", "calendar", 2, { status: "needs_sign_in", in_scan: false }), acct("Google Calendar", "calendar", 3),
  acct("Claude Docs", "files", null, { in_scan: false }),
  acct("Google Drive", "files", null, { status: "needs_sign_in", in_scan: false }),
  acct("Google Slides", "files", null, { in_scan: false }),
  acct("Google Sheets", "files", null, { in_scan: false, on: false }),
  acct("Acme Tracker", "other", null, { status: "failed", in_scan: false, claude_ai: false }),
] };
const macSources = [
  { id: "messages", name: "Messages", status: "allowed", on: true, why: "Home reads unread messages; it never replies.", settings_url: "" },
  { id: "reminders", name: "Reminders", status: "allowed", on: true, why: "Home reads due and overdue reminders.", settings_url: "" },
  { id: "calendar", name: "Calendar app", status: "not_asked", on: false, why: "Not asked yet.", settings_url: "" },
  { id: "contacts", name: "Contacts", status: "denied", on: false, why: "You turned it down in System Settings.", settings_url: "" },
];

import { homeTasks } from "./home845/fixtures";

const told: string[] = [];
const notes: string[] = [];

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
    // Held for the shot: the row stays "checking" while the shot is taken.
    case "home_reach_check_one": await wait(20_000); return reach;
    case "list_notes": return notes.map((name) => ({ name, bytes: 1, modified: ago(0), summary: "", kind: "markdown" }));
    case "save_note": notes.push(String((a as { name?: string })?.name ?? "")); return { name: (a as { name?: string })?.name, bytes: 1, modified: ago(0), summary: "", kind: "markdown" };
    case "claude_browser_status": return null;
    case "home_sources": return macSources;
    case "home_routes": return { cards: [], held: [], started: [] };
    case "named_files": case "for_you_files": case "search_backends": case "centre_proposals": case "centre_dream_commits": case "turn_usage": case "list_threads": case "nightshift_projects": case "tidy_memory": case "tidy_threads":
      return [];
    case "home_tasks": return homeTasks;
    case "home_task_event": told.push(String((a as { line?: string })?.line ?? "")); return null;
    case "home_task_close": return null;
    case "home_stage_focus": return null;
    default: return null;
  }
};

async function run() {
  // bin/snap's hidden window runs no animation: draw every arrival at its end state.
  document.head.insertAdjacentHTML("beforeend", "<style>*,*::before,*::after{animation:none!important;transition:none!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important}.lk-veil,.lk-scan,.toasts{display:none!important}</style>");
  localStorage.clear();
  sessionStorage.clear();
  const TASK_TAB: Record<string, string> = { timeline: "task:moving-the-review", todo: "task:working-your-list", triage: "task:sorting-what-arrived", browse: "task:renewing-the-permit", run: "task:merge-round-t", research: "task:cache-pricing" };
  Object.assign(kept, { focus: s === "chat" ? "chat" : s === "brief" ? "brief" : TASK_TAB[s] ?? "watch", strip: "open", stripFor: "", ui: {} });
  // focus=1 (batch 4): the stage has seen only the task in focus, so the others arrive as new while he is at the stage —
  // they wait "ready →"; split=1 also turns Split on (the newest task beside the one in focus).
  if (q.get("focus") === "1") kept.ui["stage:focus"] = { follow: true, split: q.get("split") === "1", primed: true, ready: [], seen: { [TASK_TAB[s] ?? "watch"]: 0 } };
  else kept.ui["stage:focus"] = { follow: true, split: false, primed: false, ready: [], seen: {} };
  // p872=1 (item 872): one tab waiting "ready →", a done task folded away ("1 done"), Home's steps open on the phone.
  if (q.get("p872") === "1") {
    const ids = ["task:moving-the-review", "task:working-your-list", "task:sorting-what-arrived", "task:renewing-the-permit", "task:merge-round-t", "task:cache-pricing"];
    const r = (homeTasks as { id: string; state: string }[]).find((t) => t.id === "cache-pricing");
    if (r) r.state = "done";
    kept.ui["stage:focus"] = { follow: true, split: false, primed: true, ready: ["task:renewing-the-permit"], seen: Object.fromEntries(ids.map((i) => [i, 9])), doneSeen: { "task:cache-pricing": Date.now() - 300_000 }, folded: ["task:cache-pricing"] };
    kept.ui["phone:steps"] = { open: true };
  }
  // runctl=1 (item 872): Run after Stop now (its chat stopped, Resume shown) with a done step open (Run this step again).
  if (q.get("runctl") === "1") kept.ui["task:merge-round-t"] = { stop: false, halted: true, open: "r:merge", again: ["r:merge"] };
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
    if (s === "browse") click(".h9-wide .h9-acts .jb.send");
    if (s === "run") click(".h9-ph-tools .jb.danger");
    if (s === "research") {
      click(".s-claim .jb");
      click(".y-end .jb.send");
    }
    if (s === "brief") click(".h9-ph-tools .jb:not(.send)");
    await wait(200);
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
    restart = ` restart=${saved.length}B told=${told.length} notes=${notes.length}`;
  }
  // checkone=1: one source's own Check now pressed (the stub holds it, so the row shows it checking).
  if (q.get("checkone") === "1") {
    document.querySelectorAll<HTMLElement>(".w-src .w-chk .jb")[2]?.click();
    await wait(300);
  }
  // srcend=1 (item 873): the Sources panel scrolled to its end, so a shot shows the rows below the fold (off,
  // failed, the Mac's apps).
  if (q.get("srcend") === "1") {
    const pb = document.querySelector<HTMLElement>(".w-grp")?.closest<HTMLElement>(".h9-pb");
    if (pb) pb.scrollTop = pb.scrollHeight;
    await wait(300);
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
