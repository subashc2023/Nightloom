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
import { mount, flushSync, tick } from "svelte";
import App from "../src/App.svelte";
import { app, openSession } from "../src/lib/state.svelte";
import { railFold } from "../src/lib/railFold.svelte";
import { setLayout } from "../src/lib/layout.svelte";
import { stage as kept } from "../src/lib/homeStage/stageState.svelte";

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

(window as unknown as { __stub: (c: string, a?: Record<string, unknown>) => Promise<unknown> }).__stub = async (cmd) => {
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
    case "named_files": case "for_you_files": case "search_backends": case "centre_proposals": case "centre_dream_commits": case "list_notes": case "turn_usage": case "list_threads": case "nightshift_projects": case "tidy_memory": case "tidy_threads": case "home_tasks":
      return [];
    default: return null;
  }
};

async function run() {
  // bin/snap's hidden window runs no animation: draw every arrival at its end state.
  document.head.insertAdjacentHTML("beforeend", "<style>*,*::before,*::after{animation:none!important;transition:none!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important}.lk-veil,.lk-scan,.toasts{display:none!important}</style>");
  localStorage.clear();
  sessionStorage.clear();
  Object.assign(kept, { focus: s === "chat" ? "chat" : s === "brief" ? "brief" : "watch", strip: "open", stripFor: "", ui: {} });
  if (q.get("classic") === "1") setLayout("classic");
  mount(App, { target: document.getElementById("app")! });
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
  // What a script can read off the shot's page: the stage is there, and nothing on it is cut off or scrolls sideways.
  const stage = document.querySelector<HTMLElement>("[data-home-stage]");
  const bad: string[] = [];
  for (const el of stage?.querySelectorAll<HTMLElement>("*") ?? []) {
    if (el instanceof SVGElement || el.closest(".h9-chat")) continue;
    const cs = getComputedStyle(el);
    const dx = el.scrollWidth - el.clientWidth;
    if (dx > 1 && /(hidden|clip|auto|scroll)/.test(cs.overflowX) && !/h9-tabs|h9-doing|b-counts|b-count/.test(el.className)) bad.push(`${el.className.split(" ")[0]} +${dx}`);
  }
  const r = stage?.getBoundingClientRect();
  document.title = `845 s=${s} stage=${r ? `${Math.round(r.width)}x${Math.round(r.height)}` : "MISSING"} tabs=${[...document.querySelectorAll(".h9-tab .tn")].map((n) => n.textContent).join("|")} welcome=${document.querySelector(".welcome") ? "yes" : "no"} composer=${document.querySelector(".composer") ? "yes" : "no"} cut=${bad.length}${bad.length ? ` (${bad.slice(0, 4).join(", ")})` : ""}`;
  if (q.get("cap") === "1") (window as unknown as { __capset: (m: string) => void }).__capset(document.title);
}
if (document.readyState === "loading") addEventListener("DOMContentLoaded", () => void run());
else void run();
