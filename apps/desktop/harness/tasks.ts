// Backlog 267 harness — see tasks.html.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource-variable/newsreader";
import { mount, flushSync, type Component } from "svelte";
import RunningTasks from "../src/lib/RunningTasks.svelte";
import { app, type SubagentRow } from "../src/lib/state.svelte";

const q = new URLSearchParams(location.search);
const now = Date.now();
const S = "s-open";

type Spec = [type: string, desc: string, model: string, status: string, turn: number, agoS: number, durS: number, tokens: number, tools: number];
// Three sends: turn 1 (6 agents, one failed), turn 2 (6), turn 3 — the latest — (6: 3 running, 3 done).
const specs: Spec[] = [
  ["Explore", "Find every caller of liveChats", "claude-haiku-4-5-20251001", "completed", 1, 3600, 41, 18_400, 12],
  ["Explore", "Map the budget hook's ledger fields", "claude-haiku-4-5-20251001", "completed", 1, 3590, 63, 22_100, 17],
  ["general-purpose", "Read the 159 A4 report and list what is left", "claude-opus-5-5", "completed", 1, 3580, 118, 41_800, 9],
  ["Explore", "Where the chip's tooltip is built", "claude-haiku-4-5-20251001", "completed", 1, 3570, 22, 9_300, 5],
  ["reusable", "Check the release roll's log format", "claude-sonnet-5-0", "failed", 1, 3560, 9, 3_100, 1],
  ["Explore", "Sidebar row menu: every item and its gate", "claude-haiku-4-5-20251001", "completed", 1, 3550, 54, 20_700, 14],
  ["general-purpose", "Draft the 267 spec from the backlog item", "claude-opus-5-5", "completed", 2, 1800, 212, 64_300, 21],
  ["Explore", "List palettes A–D and their tokens", "claude-haiku-4-5-20251001", "completed", 2, 1790, 31, 11_900, 6],
  ["Explore", "Find the harness pattern used by 242", "claude-haiku-4-5-20251001", "completed", 2, 1780, 38, 14_200, 8],
  ["Plan", "Plan the grouping: running, this send, earlier", "claude-opus-5-5", "completed", 2, 1770, 96, 33_600, 4],
  ["Explore", "Where does subagentsOfTurn get read", "claude-haiku-4-5-20251001", "completed", 2, 1760, 27, 10_400, 7],
  ["reusable", "Measure the modal at 1150 and 1440 wide", "claude-sonnet-5-0", "completed", 2, 1750, 144, 38_900, 19],
  ["general-purpose", "Rewrite RunningTasks.svelte as grouped lists", "claude-opus-5-5", "running", 3, 240, 0, 88_200, 26],
  ["Explore", "Collect every place the Running tasks page is opened", "claude-haiku-4-5-20251001", "completed", 3, 230, 44, 16_800, 11],
  ["reusable", "Write vitest cases for the grouping helper", "claude-sonnet-5-0", "running", 3, 200, 0, 27_500, 8],
  ["Explore", "Check svelte-check on the new file", "claude-haiku-4-5-20251001", "completed", 3, 190, 19, 7_600, 3],
  ["general-purpose", "Snap before and after shots in WebKit at both widths", "claude-opus-5-5", "running", 3, 95, 0, 12_900, 5],
  ["Explore", "Read the chip's 'N agents · done' wording", "claude-haiku-4-5-20251001", "completed", 3, 150, 12, 5_200, 2],
];
const rows: SubagentRow[] =
  q.get("agents") === "0"
    ? []
    : specs.map(([type, desc, model, status, turn, agoS, durS, tokens, tools], i) => ({
        tool_use_id: `toolu_${i}`,
        task_id: `t${i}`,
        subagent_type: type,
        description: desc,
        prompt: `${desc}. Report paths and line numbers.`,
        status,
        background: false,
        model,
        tokens,
        tool_uses: tools,
        duration_ms: durS * 1000,
        usage: { input_tokens: Math.round(tokens * 0.8), output_tokens: Math.round(tokens * 0.2), cache_read_tokens: tokens * 3, cache_write_tokens: Math.round(tokens / 2) },
        rounds: Math.max(1, tools),
        session: S,
        turn,
        startedAt: now - agoS * 1000,
        updatedAt: now - (agoS - durS) * 1000,
        segments: [],
      }));

const A = app as unknown as Record<string, unknown>;
app.activeSessionId = S;
app.subagents = rows;
A.turnSeq = 3;
A.sessions = [{ id: S, title: "Running tasks redesign", first_user: "redesign the running tasks page" }];
if (q.get("chats") !== "0") {
  A.busy = true;
  A.events = [{ event: "user_message", at: new Date(now - 250_000).toISOString(), text: "go" }];
  A.liveUsage = { input_tokens: 61_000, output_tokens: 3_400 };
  A.background = {
    "s-bg": {
      session: "s-bg",
      name: "Fly deploy for the phone page",
      events: [{ event: "user_message", at: new Date(now - 734_000).toISOString(), text: "deploy" }],
      liveUsage: { input_tokens: 118_000, output_tokens: 9_100 },
      approvals: [{}],
      budget: null,
      project: null,
    },
  };
}
A.planUsage = { five_hour: 41 };
app.showTasks = true;

// ?before=1 draws the page as of bee1086 — a copy made only while snapping the before shots, not committed.
const before = q.get("before") === "1" ? ((await import(/* @vite-ignore */ "../src/lib/RunningTasks" + "Before.svelte")).default as Component) : null;
mount(before ?? RunningTasks, { target: document.getElementById("overlay")! });
flushSync();
if (q.get("earlier") === "1") {
  (document.querySelector("[data-group='earlier'] .group-head") as HTMLElement | null)?.click();
  flushSync();
}
if (q.get("scroll") === "end") {
  const pane = document.querySelector(".pane") as HTMLElement | null;
  if (pane) pane.scrollTop = pane.scrollHeight;
}
setTimeout(() => {
  const m = document.querySelector(".modal") as HTMLElement | null;
  const r = m?.getBoundingClientRect();
  const clipped = Array.from(document.querySelectorAll<HTMLElement>(".modal *")).filter(
    (e) => getComputedStyle(e).textOverflow === "ellipsis" && e.scrollWidth > e.clientWidth,
  ).length;
  (window as unknown as { __measure: unknown }).__measure = { w: r?.width, h: r?.height, clipped };
  const line = `modal ${Math.round(r?.width ?? 0)}x${Math.round(r?.height ?? 0)} · ellipsised cells ${clipped} · viewport ${innerWidth}x${innerHeight}`;
  document.title = line;
  if (q.get("cap") === "1") document.getElementById("cap")!.textContent += line;
}, 300);
