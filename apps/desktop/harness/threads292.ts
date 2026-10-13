// Backlog 292 harness — see threads292.html. Real clicks on the real Sidebar: the chevron (fold), the thread's
// name (the view), a section, a file; the caption reports what the DOM shows after each.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import { mount, flushSync, tick } from "svelte";
import Sidebar from "../src/lib/Sidebar.svelte";
import { app } from "../src/lib/state.svelte";

const q = new URLSearchParams(location.search);
document.documentElement.dataset.palette = q.get("p") ?? "A";
const view = q.get("view") ?? "sections";
const cap = document.getElementById("cap")!;

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const chat = (id: string, title: string, min: number, thread?: string) => ({
  id, title, mode: "normal", kind: "build", modified: ago(min), ...(thread ? { thread } : {}),
});
const sessions = [
  chat("a1f0c2d3-s10", "Stuart 10 — proxy evaluator sizing", 4, "stuart-brainstorm"),
  chat("b2e1d3c4-legal", "Lease clause 7 negotiation", 25),
  chat("c3d2e4f5-s9", "Stuart 9 — what counts as a round", 80, "stuart-brainstorm"),
  chat("d4c3f5a6-ace", "ACE extrapolation, second pass", 190, "ace-extrapolation"),
  chat("e5b4a6b7-misc", "Rename the fixtures folder", 300),
  chat("f6a5b7c8-s8", "Stuart 8 — the replay eval", 1500, "stuart-brainstorm"),
];
const threads = [
  { slug: "stuart-brainstorm", title: "Stuart brainstorm (Deep Thoughts)", status: "As of 2026-10-03, 11:40 AM — proxy stays small; next: size the replay set", touched: "2026-10-03", start_here_words: 410, tokens: 5200, flags: 0 },
  { slug: "ace-extrapolation", title: "ACE extrapolation", status: "As of 2026-10-01, 11:15 PM — concept split reproduced on toy data", touched: "2026-10-01", start_here_words: 300, tokens: 3100, flags: 1 },
];

const THREAD_MD = `# Thread: Stuart brainstorm (Deep Thoughts)

Pointer form: \`<chat id> ev <n> ¶<k>\` = chat, event index, paragraph. Rules: \`## How to edit\`.

## Start here
As of 2026-10-03, 11:40 AM — the proxy evaluator stays small; next, size the replay set.

**The question.** Can a small proxy, trained on his answered blockers, predict which of two plans he would pick?
His framing: "I don't want a judge, I want something that guesses me and is wrong in ways I can see" (c3d2e4f5 ev 12 ¶2).

**Front of the queue.** Q-4 size the replay set (live); Q-6 decide whether chat answers count as blockers (parked).

**What changed in Stuart 10.** C-7 struck (the 200-item floor came from a misread table); C-9 added.

**Files.** \`.agents/notes/replay-eval.md\` (the eval's design), \`blockers/DECIDED.md\` (the substrate).

## Queue
| id | Item | Status | Pointer |
|---|---|---|---|
| Q-4 | Size the replay set: how many answered blockers before the proxy beats a coin | live | a1f0c2d3 ev 30 |
| Q-5 | Hold out by date, not at random | done | c3d2e4f5 ev 41 |
| Q-6 | Do decisions answered in chat count as blockers? | parked — his call | f6a5b7c8 ev 7 |

## Claims
| id | Claim | Tag | Status | Pointer |
|---|---|---|---|---|
| C-7 | ~~A proxy needs 200 items~~ (struck 2026-10-03: misread table) → C-9 | external | struck | a1f0c2d3 ev 22 |
| C-9 | Source "Bradley–Terry fits" claims 60–80 pairwise items suffice for a 2-way pick | external, unverified | live | a1f0c2d3 ev 26 |

## His view
- "It should be wrong in ways I can see, not right in ways I can't." (c3d2e4f5 ev 12 ¶2)

## The model's reading of his view
(inferred) He values a legible miss over an opaque hit.

## Tried and failed / rejected

## Vocabulary
- **Proxy** — the small model that guesses his pick.

## How to edit
- One writer: the chat currently working from this thread.
`;
const LOG_MD = `# Log: Stuart brainstorm (Deep Thoughts)

One dated paragraph per round, appended, never edited.

2026-10-01, 9:12 PM — chat f6a5b7c8 (Stuart 8): asked for the replay eval's shape; Q-5 added; long output in \`.agents/notes/replay-eval.md\`.

2026-10-02, 7:41 PM — chat c3d2e4f5 (Stuart 9): what counts as a round; C-7 added, Q-6 parked.

2026-10-03, 11:40 AM — chat a1f0c2d3 (Stuart 10): proxy sizing; C-7 struck → C-9; Start here rewritten.
`;

(window as unknown as { __stub: (c: string, a?: Record<string, unknown>) => Promise<unknown> }).__stub = async (cmd, args) => {
  switch (cmd) {
    case "list_threads":
      return threads;
    case "list_sessions":
      return sessions;
    case "read_note": {
      const name = String(args?.name ?? "");
      if (name === "threads/stuart-brainstorm/thread.md") return THREAD_MD;
      if (name === "threads/stuart-brainstorm/log.md") return LOG_MD;
      throw `cannot read ${name}: No such file or directory (os error 2)`;
    }
    default:
      throw `stub: ${cmd}`;
  }
};

localStorage.setItem("nightloom.threadsClosed", JSON.stringify(["p1/ace-extrapolation"]));
app.project = { id: "p1", name: "Value Generalization", root: "/Users/you/research/value-generalization" } as unknown as typeof app.project;
app.sessions = sessions as unknown as typeof app.sessions;
app.activeSessionId = "b2e1d3c4-legal";
app.events = [{ event: "session_created", id: app.activeSessionId, at: ago(25) }] as unknown as typeof app.events;

mount(Sidebar, { target: document.getElementById("side")! });
flushSync();

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rowsOf = () =>
  Array.from(document.querySelectorAll(".thread-group")).map((g) => {
    const name = g.querySelector(".tg-name")?.textContent?.trim();
    return `${name} [${g.querySelectorAll(".session-row").length} rows, expanded=${g.querySelector(".tg-toggle")?.getAttribute("aria-expanded")}]`;
  });
async function run() {
  await wait(150);
  await tick();
  const log: string[] = [];
  const heads = Array.from(document.querySelectorAll(".section-head [role=heading], .section-head[role=heading]")).map((h) => h.textContent?.trim());
  log.push(`headings: ${heads.join(" | ")}`);
  const stuart = document.querySelectorAll(".thread-group")[0];
  if (view === "fold") {
    stuart.querySelector<HTMLButtonElement>(".tg-toggle")!.click();
    await tick();
    log.push(`after chevron click: view open=${!!document.querySelector(".tv")}`);
  } else if (view !== "sections") {
    stuart.querySelector<HTMLButtonElement>(".tg-open")!.click();
    await wait(50);
    await tick();
    log.push(`after name click: view open=${!!document.querySelector(".tv")}, group still ${stuart.querySelector(".tg-toggle")?.getAttribute("aria-expanded") === "true" ? "open" : "closed"}`);
    if (view === "queue") {
      Array.from(document.querySelectorAll<HTMLButtonElement>(".tv-sec")).find((b) => b.textContent?.trim().startsWith("Queue"))?.click();
    } else if (view === "log") {
      Array.from(document.querySelectorAll<HTMLButtonElement>(".tv-file")).find((b) => b.textContent === "log.md")?.click();
    }
    await wait(50);
    await tick();
    log.push(`shown: ${document.querySelector(".tv-sec.on")?.textContent?.trim() ?? document.querySelector(".tv-file.on")?.textContent}`);
  }
  await wait(100);
  cap.textContent = `view=${view} p=${document.documentElement.dataset.palette}\n${log.join("\n")}\n${rowsOf().join("\n")}\nloose: ${document.querySelectorAll(".loose .session-row").length}`;
}
void run();
