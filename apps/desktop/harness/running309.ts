// Backlogs 308 + 309 harness — see running309.html. The real App, the Tauri backend stubbed (unknown commands answer
// null and are listed in the caption). Project "ICS 51" open with its chat streaming on screen; a chat in "Nightloom"
// running off screen with a subagent; the dream; a Nightshift shift in a third project.
//   shot=badge  the window with the badge at the tab strip's right end
//   shot=panel  the badge clicked: the Running-tasks panel, its first group every run in every project
//   shot=quit   the quit dialog Rust's ask puts up
import "@fontsource-variable/newsreader/wght.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "../src/app.css";
import { mount, flushSync, tick } from "svelte";
import App from "../src/App.svelte";
import { app } from "../src/lib/state.svelte";
import { allRunning, quitAsk } from "../src/lib/running.svelte";
import { quitLines } from "../src/lib/running";

const q = new URLSearchParams(location.search);
const shot = q.get("shot") ?? "badge";
const cap = document.getElementById("cap")!;
const unknown = new Set<string>();
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const project = { id: "p51", name: "ICS 51", root: "/Users/you/school/ics-51", notes_dir: "/Users/you/school/ics-51/.agents/notes", chats: 2, notes: 0, exists: true };
const other = { id: "pnl", name: "Nightloom", root: "/Users/you/nightloom", notes_dir: "/Users/you/nightloom/.agents/notes", chats: 9, notes: 0, exists: true };
const sessions = [
  { id: "s1-midterm", title: "Pipelining hazards", mode: "normal", kind: "build", modified: ago(3) },
  { id: "s2-lab", title: "Lab 4 — cache simulator", mode: "normal", kind: "build", modified: ago(200) },
];

(window as unknown as { __stub: (c: string, a?: Record<string, unknown>) => Promise<unknown> }).__stub = async (cmd) => {
  switch (cmd) {
    case "list_sessions":
      return sessions;
    case "list_projects":
      return [project, other];
    case "list_notes":
    case "providers":
    case "nightshift_projects":
    case "list_threads":
    case "centre_proposals":
    case "centre_dream_commits":
      return [];
    default:
      unknown.add(cmd);
      return null;
  }
};

try {
  localStorage.clear();
} catch {
  /* private mode */
}
document.documentElement.dataset.palette = q.get("p") ?? "A";
mount(App, { target: document.getElementById("app")! });
flushSync();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run() {
  await wait(400);
  app.projects = [project, other] as unknown as typeof app.projects;
  app.project = project as unknown as typeof app.project;
  app.sessions = sessions as unknown as typeof app.sessions;
  app.connection = {
    provider: "anthropic", model: "claude-opus-5-5", thinking: "default", tools: true, contextLimit: 200000, price: null,
    mcp: [], reviewers: [], workspace: project.root, search: null, knowledge: null, engine: "claude-code", agent: null,
  } as unknown as typeof app.connection;
  app.activeSessionId = "s1-midterm";
  app.events = [{ event: "user_message", text: "Walk me through the load-use hazard in the five-stage pipeline.", at: ago(3.2) }] as unknown as typeof app.events;
  app.live = { segments: [{ kind: "text", text: "A load-use hazard happens when an instruction needs a register that the load just before it has not yet written. " }] } as unknown as typeof app.live;
  app.busy = true;
  app.background = {
    "c-roll": {
      session: "c-roll", pendingMode: "normal", pendingKind: "build",
      events: [{ event: "user_message", text: "Fix the release roll", at: ago(11.5) }],
      live: { segments: [{ kind: "tool", call: { id: "t1", name: "Bash", input: {}, result: null } }] },
      liveUsage: { input_tokens: 41200, output_tokens: 1800 },
      approvals: [], project: other.id, projectName: other.name, name: "Confirm quit while running",
    },
  } as unknown as typeof app.background;
  app.subagents = [{
    tool_use_id: "toolu_a", task_id: "", subagent_type: "Explore", description: "Find where councils run", prompt: "", status: "running",
    background: false, tokens: 18400, tool_uses: 7, duration_ms: 0, usage: { input_tokens: 0, output_tokens: 0 }, rounds: 0,
    session: "c-roll", turn: 1, startedAt: Date.now() - 4.3 * 60_000, updatedAt: Date.now(),
    segments: [{ kind: "tool", call: { id: "g", name: "Grep", input: {}, result: null } }],
  }] as unknown as typeof app.subagents;
  app.dreaming = true;
  app.dreamActivity = "write_note";
  app.centre.rows = [{ id: "ploom", name: "Lanternfish", workspace: null, exists: true, disabled: null, nightshift: { live: true } }] as unknown as typeof app.centre.rows;
  await tick();
  await wait(1300);
  const log: string[] = [];
  const badge = document.querySelector<HTMLButtonElement>(".run-badge");
  log.push(`badge: ${badge ? badge.textContent?.replace(/\s+/g, " ").trim() : "absent"}`);
  if (badge) {
    const r = badge.getBoundingClientRect();
    log.push(`badge rect ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)} (window ${innerWidth})`);
  }
  if (shot === "panel") {
    badge?.click();
    await tick();
    await wait(300);
    log.push(`panel rows: ${[...document.querySelectorAll('[data-group="everywhere"] .row')].length}`);
  }
  if (shot === "quit") {
    quitAsk.open = true;
    await tick();
    await wait(300);
  }
  log.push(`runs: ${allRunning().length}; quit lines: ${quitLines(allRunning()).join(" | ")}`);
  if (unknown.size) log.push(`unstubbed: ${[...unknown].join(", ")}`);
  cap.textContent = log.join("\n");
}
void run();
