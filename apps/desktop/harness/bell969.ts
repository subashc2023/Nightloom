// Items 968-969 harness — see bell969.html. The real App, the Tauri backend stubbed, fed with synthetic data shaped
// like his on 2026-11-25 (916-911 report): dream commits over 10 days in the vault and 7 projects, dream writes with
// no commit, Claude Code memory changes, 5 pending proposals, one Nightshift project with 19 open blockers (3 held,
// 16 default: applied) and 24 shipped items, an unread morning page, a release. Never his real data.
import "@fontsource-variable/newsreader/wght.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "../src/app.css";
import { mount, flushSync, tick } from "svelte";
import App from "../src/App.svelte";
import { app } from "../src/lib/state.svelte";
import { setLayout } from "../src/lib/layout.svelte";
import { needsNow } from "../src/lib/needsBoard.svelte";
import { waitingCount } from "../src/lib/needsYou";
import { bellList } from "../src/lib/centre";

const q = new URLSearchParams((window as unknown as { __h9q?: string }).__h9q ?? location.search);
const cap = document.getElementById("cap")!;
const unknown = new Set<string>();

const day = (d: number, h = 3) => {
  const t = new Date();
  t.setDate(t.getDate() - d);
  t.setHours(h, 10, 0, 0);
  return t.toISOString();
};
const names = ["nightshift-code", "Nightloom", "AISC", "ics-51", "hopecraft", "spar", "reading"];
const projects = names.map((n, i) => ({ id: `p${i}`, name: n, root: `/Users/you/${n}`, notes_dir: `/Users/you/${n}/.agents/notes`, chats: 3, notes: 3, exists: true }));
const refs = projects.map((p) => ({ id: p.id, name: p.name }));
const commits = [
  ...Array.from({ length: 10 }, (_, i) => ({ project: null, repo: "/Users/you/vault", hash: `v${i}abcdef`, at: day(i), subject: "dream", files: [{ path: `note-${i}.md`, added: 4, removed: 1 }] })),
  ...Array.from({ length: 60 }, (_, i) => ({
    project: refs[i % 7],
    repo: projects[i % 7].root,
    hash: `c${i}abcdef`,
    at: day(Math.floor(i / 6)),
    subject: "dream",
    files: [{ path: `notes/topic-${i}.md`, added: 3, removed: 2 }, ...(i % 10 === 0 ? [{ path: "AGENTS.md", added: 1, removed: 0 }] : [])],
  })),
];
const entry = (id: string, at: string, why: string, applied = false) => ({ id, proposal: { v: 1, at, target: { kind: "user" }, why, text: "…", from_dream: true, ...(applied ? { applied: { at } } : {}) } });
const applied = Array.from({ length: 52 }, (_, i) => ({ project: refs[i % 7], entry: entry(`a${i}`, day(i % 9, 4), "A rule the dream wrote", true), file: "AGENTS.md" }));
const memory = Array.from({ length: 10 }, (_, i) => ({ hash: `m${i}abcdef`, at: day(i, 5), subject: "sync", files: [{ path: "-Users-you/memory/a.md", added: 2, removed: 0 }], places: ["nightshift-code"] }));
const proposals = Array.from({ length: 5 }, (_, i) => ({ project: refs[i], entry: entry(`pr${i}`, day(0, 4), "Three chats asked for the same rule; the instructions would say it up front.") }));
const blockers = Array.from({ length: 19 }, (_, i) => ({
  id: String(2270 + i),
  file: `${2270 + i}-x.md`,
  path: "",
  status: "open",
  raised: "2026-11-24",
  shift: "",
  item: String(960 + i),
  follow_up: null,
  question: i < 3 ? `Held question ${i + 1}: should the roll wait for the review?` : `Defaulted question ${i - 2}: which of two layouts for the panel?`,
  guess: "Build the default and list it in the report.",
  blocks: "",
  answer: "",
  where_guess_lives: "",
  fields: { default: i < 3 ? "held" : "applied" },
  sections: [],
}));
const items = Array.from({ length: 24 }, (_, i) => ({ id: String(930 + i), title: `Shipped item ${i + 1}`, kind: "build", status: "shipped", fields: { shipped: "2026-11-24" } }));
const nsRow = {
  id: "p0",
  name: "nightshift-code",
  workspace: projects[0].root,
  exists: true,
  disabled: null,
  nightshift: { newest_morning: "2026-11-25.md", open_blockers: 19, held_blockers: 3, items: 40, config: { kind: "build" } },
};

(window as unknown as { __stub: (c: string, a?: Record<string, unknown>) => Promise<unknown> }).__stub = async (cmd) => {
  switch (cmd) {
    case "centre_proposals":
      return proposals;
    case "centre_dream_commits":
      return commits;
    case "centre_applied":
      return applied;
    case "centre_claude_memory":
      return memory;
    case "build_stamp":
      return { version: "0.1.0", exe_modified: day(1, 9) };
    case "nightshift_projects":
      return [nsRow];
    case "nightshift_blockers":
      return { blockers, errors: [] };
    case "nightshift_items":
      return { items, errors: [] };
    case "list_projects":
      return projects;
    case "home_feed":
      return { rows: [], seen_at: null };
    case "list_threads":
    case "list_sessions":
    case "list_notes":
    case "providers":
    case "tidy_memory":
    case "tidy_threads":
    case "flat_canary":
      return [];
    default:
      unknown.add(cmd);
      return null;
  }
};

try {
  localStorage.clear();
  // A release seen before, so this one is announced.
  localStorage.setItem("nightloom.centre.build", "older");
} catch {
  // no storage
}
if (q.get("classic") === "1") setLayout("classic");
mount(App, { target: document.getElementById("app")! });
flushSync();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run() {
  await wait(500);
  app.project = projects[0] as unknown as typeof app.project;
  await tick();
  await wait(600);
  const log: string[] = [];
  if (q.get("needs") === "1") {
    app.showNeeds = true;
    await tick();
    await wait(600);
    if (q.get("decided") === "1") {
      [...document.querySelectorAll<HTMLButtonElement>(".group-head")].find((b) => b.textContent?.includes("Decided for you"))?.click();
      await wait(200);
    }
    const heads = [...document.querySelectorAll(".group-head")].map((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim());
    log.push(`groups: ${heads.join(" | ")}`);
  } else {
    const bell = document.querySelector<HTMLButtonElement>(".centre-bell");
    log.push(`bell: ${!!bell}, dot: ${!!document.querySelector(".centre-bell .centre-dot")}, number: ${JSON.stringify(bell?.textContent?.replace("🔔", "").trim() ?? "")}`);
    bell?.click();
    await wait(500);
    await tick();
    if (q.get("open") === "today") {
      document.querySelector<HTMLButtonElement>(".centre-day-btn")?.click();
      await wait(200);
    }
    if (q.get("seen") === "1") {
      [...document.querySelectorAll<HTMLButtonElement>(".centre-head button")].find((b) => b.textContent?.includes("Mark all seen"))?.click();
      await wait(200);
      log.push(`after Mark all seen, dot: ${!!document.querySelector(".centre-bell .centre-dot")}`);
    }
    const rows = document.querySelectorAll(".centre-panel .centre-day, .centre-panel .centre-kind.alone").length;
    log.push(`panel rows (days + alone): ${rows}; else-line: ${JSON.stringify(document.querySelector(".centre-else")?.textContent?.trim() ?? "")}`);
  }
  const badge = document.querySelector(".need-badge");
  log.push(`needs badge: ${JSON.stringify(badge?.textContent?.replace(/\s+/g, " ").trim() ?? "none")}; waiting=${waitingCount(needsNow())}`);
  log.push(`notices=${app.centre.notices.length}; bellList rows=${(() => { const b = bellList(app.centre.notices, app.centre.seen, new Date()); return b.days.length + b.alone.length; })()}`);
  log.push(`stub unknown: ${[...unknown].slice(0, 8).join(", ")}`);
  cap.textContent += log.join("\n");
}
void run();
