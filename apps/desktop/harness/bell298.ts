// Backlog 298 harness — see bell298.html. The real App, the Tauri backend stubbed (unknown commands answer null and
// are listed in the caption). A project open on its new-chat page (title, folder bar, floating composer, orbiting
// note chips), the bell opened by a real DOM click, and then a probe: a 14 × 14 grid of points over each top-bar
// popover's rectangle, `document.elementFromPoint` at each, counting the points where something other than the
// popover is on top. The same probe runs on the model card (the rail) and the gauge card.
//   view=welcome  the new-chat page alone (his screenshot)
//   view=chat     a chat with turns instead of the new-chat page
//   view=split    a thread tab in a left pane, the new-chat page right: the card hangs over both panes
//   view=context  the Context page open, then the bell clicked
import "@fontsource-variable/newsreader/wght.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "../src/app.css";
import { mount, flushSync, tick } from "svelte";
import App from "../src/App.svelte";
import { app } from "../src/lib/state.svelte";
import * as tabs from "../src/lib/tabs";

const q = new URLSearchParams(location.search);
const view = q.get("view") ?? "welcome";
const cap = document.getElementById("cap")!;
const unknown = new Set<string>();

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const project = {
  id: "p51",
  name: "ICS 51",
  root: "/Users/you/school/ics-51",
  notes_dir: "/Users/you/school/ics-51/.agents/notes",
  chats: 3,
  notes: 3,
  exists: true,
};
const ref = { id: project.id, name: project.name };
const proposal = (id: string, min: number, why: string, user = false) => ({
  project: user ? null : ref,
  entry: {
    id,
    proposal: {
      v: 1,
      at: ago(min),
      target: user ? { kind: "user" } : { kind: "project", id: ref.id, name: ref.name },
      why,
      text: "…",
      from_dream: true,
    },
  },
});
const proposals = [
  proposal("pr1", 40, "Three chats this week asked for MIPS register conventions to be stated up front; the instructions now say so."),
  proposal("pr2", 95, "Office hours moved to Thursdays; the note in the instructions was stale.", false),
  proposal("pr3", 300, "You asked twice for answers without a recap paragraph; your memory now records it.", true),
  proposal("pr4", 600, "A lab's due date was read from an old syllabus; the instructions point at the new one.", false),
];
const commits = [
  { project: ref, repo: project.root, hash: "a1b2c3d", at: ago(120), subject: "nightloom: dream — 2 notes", files: [{ path: "course-progress.md", added: 6, removed: 2 }] },
  { project: null, repo: "/Users/you/vault", hash: "d4e5f6a", at: ago(500), subject: "nightloom: dream — 1 note", files: [{ path: "spar-application.md", added: 3, removed: 1 }] },
];
const threads = [
  { slug: "midterm-prep", title: "Midterm prep", status: "As of 2026-10-03 — pipelining done; next: caches", touched: "2026-10-03", start_here_words: 200, tokens: 2100, flags: 0 },
];
const sessions = [
  { id: "s1-midterm", title: "Pipelining hazards", mode: "normal", kind: "build", modified: ago(30), thread: "midterm-prep" },
  { id: "s2-lab", title: "Lab 4 — cache simulator", mode: "normal", kind: "build", modified: ago(200) },
];

(window as unknown as { __stub: (c: string, a?: Record<string, unknown>) => Promise<unknown> }).__stub = async (cmd, args) => {
  switch (cmd) {
    case "centre_proposals":
      return proposals;
    case "centre_dream_commits":
      return commits;
    case "list_threads":
      return threads;
    case "list_sessions":
      return sessions;
    case "list_projects":
      return [project];
    case "read_note":
      if (String(args?.name ?? "").endsWith("thread.md")) return "# Thread: Midterm prep\n\n## Start here\nPipelining done; next, caches.\n";
      throw "No such file or directory (os error 2)";
    case "list_notes":
    case "providers":
    case "nightshift_projects":
    case "tidy_memory":
    case "tidy_threads":
      return [];
    default:
      unknown.add(cmd);
      return null;
  }
};

try {
  localStorage.clear();
} catch {
  // no storage: the workspace starts empty anyway
}
document.documentElement.dataset.palette = q.get("p") ?? "A";
mount(App, { target: document.getElementById("app")! });
flushSync();

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Points over `el`'s rectangle where something else is on top. */
function probe(el: Element | null): string {
  if (!el) return "absent";
  const r = el.getBoundingClientRect();
  let over = 0;
  let total = 0;
  const who = new Map<string, number>();
  const N = 14;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const x = r.left + ((i + 0.5) * r.width) / N;
      const y = r.top + ((j + 0.5) * r.height) / N;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      total++;
      const top = document.elementFromPoint(x, y);
      if (top && (el.contains(top) || top.closest(".nl-tip") || top.id === "cap" || top.closest("#cap"))) continue;
      over++;
      const name = top ? `${top.tagName.toLowerCase()}.${[...top.classList].filter((c) => !c.startsWith("svelte-")).join(".")}` : "nothing";
      who.set(name, (who.get(name) ?? 0) + 1);
    }
  }
  const worst = [...who.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}×${v}`).join(", ");
  return `${over} of ${total} points covered${over ? ` (${worst})` : ""}; ${Math.round(r.width)}×${Math.round(r.height)} at ${Math.round(r.left)},${Math.round(r.top)}; parent ${el.parentElement?.tagName.toLowerCase()}${el.parentElement === document.body ? " (portalled)" : ""}; bg ${getComputedStyle(el).backgroundColor}`;
}

async function run() {
  await wait(400);
  app.project = project as unknown as typeof app.project;
  app.sessions = sessions as unknown as typeof app.sessions;
  app.leftTab = "chats";
  // The note chips that orbit the new-chat page: his `@kb · spar-application.md` and `course-progress.md`.
  const note = (name: string, min: number) => ({ name, bytes: 900, modified: ago(min), summary: name.replace(/\.md$/, "") });
  app.notes = [note("course-progress.md", 50), note("lab-4-notes.md", 400), note("midterm-topics.md", 900)] as typeof app.notes;
  app.vault = [note("spar-application.md", 70), note("reading-list.md", 3000)] as typeof app.vault;
  // A connection, so the gauge chip (and its card) is drawn.
  app.connection = {
    provider: "anthropic",
    model: "claude-opus-5-5",
    thinking: "default",
    tools: true,
    contextLimit: 200000,
    price: null,
    mcp: [],
    reviewers: [],
    workspace: project.root,
    search: null,
    knowledge: null,
    engine: "claude-code",
    agent: null,
  } as unknown as typeof app.connection;
  if (view === "chat") {
    const at = ago(10);
    app.events = [
      { event: "user_message", text: "Walk me through the load-use hazard in the five-stage pipeline.", at },
      {
        event: "assistant_message",
        model: "claude-opus-5-5",
        blocks: [{ type: "text", text: "A load-use hazard happens when an instruction needs a register that the load just before it has not yet written. ".repeat(8) }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1200, output_tokens: 300 },
      },
    ] as unknown as typeof app.events;
  }
  document.documentElement.dataset.palette = q.get("p") ?? "A";
  await tick();
  await wait(300);
  const log: string[] = [];
  if (view === "split") {
    document.querySelector<HTMLButtonElement>(".thread-group .tg-open")?.click();
    await wait(200);
    await tick();
    const t = tabs.allTabs(app.tabs).find((x) => x.content.kind === "thread");
    if (t) tabs.split(app.tabs, t.id, "left");
    await tick();
    await wait(200);
    app.tabs.focused = app.tabs.panes[app.tabs.panes.length - 1].id;
    await tick();
    log.push(`panes: ${app.tabs.panes.map((p) => tabs.activeTab(p).content.kind).join(" | ")}`);
  }
  if (view === "context") {
    app.showContext = true;
    await tick();
    await wait(200);
  }
  // The bell, by a real click.
  const bell = document.querySelector<HTMLButtonElement>(".topbar .centre-bell");
  log.push(`bell in the top bar: ${!!bell}`);
  bell?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  bell?.click();
  await wait(400);
  await tick();
  if (view === "context") log.push(`context page still open: ${app.showContext}`);
  log.push(`bell card: ${probe(document.querySelector(".centre-panel"))}`);
  const shot = q.get("shot") ?? "bell";
  if (shot === "bell") {
    // Probe the other two top-bar cards, then put the bell's back for the picture.
    app.centre.open = false;
    app.showRail = true;
    await tick();
    await wait(200);
    log.push(`model card: ${probe(document.querySelector(".popover"))}`);
    app.showRail = false;
    await tick();
    const g = document.querySelector<HTMLButtonElement>(".topbar .gauge");
    g?.click();
    await wait(200);
    log.push(`gauge card: ${g ? probe(document.querySelector(".gauge-card")) : "no gauge chip (no connection in the harness)"}`);
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    bell?.click();
    await wait(300);
    await tick();
  }
  log.push(`stub unknown: ${[...unknown].slice(0, 10).join(", ")}`);
  cap.textContent += `view=${view} p=${document.documentElement.dataset.palette} notices=${app.centre.notices.length}\n${log.join("\n")}`;
}
void run();
