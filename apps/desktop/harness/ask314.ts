// Backlog 314 harness — see ask314.html. The real App, the Tauri backend stubbed (unknown commands answer null),
// the Claude Code engine on, a short chat, and one pending prompt rendered standalone at the transcript's foot:
//   case=two   his ICS 46 "Help style" question (two lines at his width) with four options and descriptions
//   case=long  a long question (a pasted test file) — shows the card's cap and the card scrolling as one
//   case=multi two questions, the second multi-select
//   case=perm  a Bash permission prompt (unchanged by 314)
// `act=1` (case=multi) picks "Sketch the cases" by a click on its row, ticks two boxes of the second question,
// types into its Other, presses Answer, and prints what reached `approve_call`.
// `drag=<px>` stores a dragged question height the way the card did before 314 (it should now be ignored).
// The caption measures the card: its height against the window, whether the card or an inner box scrolls.
import "@fontsource-variable/newsreader/wght.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "../src/app.css";
import { mount, flushSync, tick } from "svelte";
import App from "../src/App.svelte";
import { app } from "../src/lib/state.svelte";

const q = new URLSearchParams(location.search);
const which = q.get("case") ?? "two";
const cap = document.getElementById("cap")!;
const unknown = new Set<string>();
const approved: unknown[] = [];

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const project = {
  id: "p46",
  name: "ICS 46",
  root: "/Users/you/school/ics-46",
  notes_dir: "/Users/you/school/ics-46/.agents/notes",
  chats: 1,
  notes: 0,
  exists: true,
};
const sessions = [{ id: "s1-tests", title: "Project 2 tests", mode: "normal", kind: "build", modified: ago(3) }];

(window as unknown as { __stub: (c: string, a?: Record<string, unknown>) => Promise<unknown> }).__stub = async (cmd, a) => {
  switch (cmd) {
    case "approve_call":
      approved.push(a);
      return null;
    case "list_sessions":
      return sessions;
    case "list_projects":
      return [project];
    case "list_notes":
    case "providers":
    case "nightshift_projects":
    case "centre_proposals":
    case "centre_dream_commits":
    case "list_threads":
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
  const drag = q.get("drag");
  if (drag) localStorage.setItem("nightloom.ask.height.pending.question", drag);
} catch {
  // Storage off.
}
document.documentElement.dataset.palette = q.get("p") ?? "A";
mount(App, { target: document.getElementById("app")! });
flushSync();

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const helpStyle = {
  question:
    // His words, as far as his screenshot shows them (two lines at his width).
    "Earlier you told me to give nudges on ICS 46 work instead of full solutions. For these tests, which do you want?",
  header: "Help style",
  options: [
    { label: "Write the tests", description: "Full test bodies for every case; you read and run them." },
    { label: "Sketch the cases", description: "Names and one-line intents; you write the bodies." },
    { label: "Point at gaps", description: "Only say which behaviours have no test yet." },
    { label: "Nudge per test", description: "One hint at a time, as you write each one." },
  ],
};
const longQ = {
  question:
    "Here is the test file as it stands, so you can see what I mean before you choose.\n\n" +
    Array.from(
      { length: 18 },
      (_, i) =>
        `Case ${i + 1}: inserting key ${i * 7} into a tree of height ${2 + (i % 4)} should keep the AVL balance factor of every ancestor within one, and the in-order walk should stay sorted.`,
    ).join("\n") +
    "\n\nWhich of these should I keep, and should I write the rotations' own tests too?",
  header: "Which cases",
  options: helpStyle.options,
};
const multi = {
  question: "Which data structures should the extra tests cover?",
  header: "Coverage",
  multiSelect: true,
  options: [{ label: "AVL tree" }, { label: "Hash map" }, { label: "Priority queue", description: "the binary heap" }],
};

const req =
  which === "perm"
    ? {
        id: "toolu_perm",
        name: "Bash",
        input: {
          command: "cd ~/school/ics-46/project2 && make test 2>&1 | tail -40",
          description: "Build the project and run the test suite to see which of the new cases fail.",
        },
        effect: "exec",
      }
    : {
        id: "toolu_ask",
        name: "AskUserQuestion",
        input: { questions: which === "long" ? [longQ] : which === "multi" ? [helpStyle, multi] : [helpStyle] },
        effect: "read_only",
      };

async function run() {
  await wait(400);
  app.project = project as unknown as typeof app.project;
  app.sessions = sessions as unknown as typeof app.sessions;
  app.connection = { ...(app.connection ?? {}), engine: "claude-code" } as unknown as typeof app.connection;
  const at = ago(10);
  app.events = [
    { event: "user_message", text: "Can you write tests for the AVL tree in project 2?", at },
    {
      event: "assistant_message",
      model: "claude-opus-5-5",
      blocks: [{ type: "text", text: "Before I start, one question about how much to write." }],
      stop_reason: "tool_use",
      usage: { input_tokens: 1200, output_tokens: 40 },
    },
  ] as unknown as typeof app.events;
  app.busy = true;
  app.pendingApprovals = [req as unknown as (typeof app.pendingApprovals)[number]];
  await tick();
  await wait(500);
  const vp = document.querySelector<HTMLElement>(".transcript");
  if (vp) vp.scrollTop = vp.scrollHeight;
  await wait(200);
  const card = document.querySelector<HTMLElement>(".ask");
  const log: string[] = [`case=${which} window=${innerWidth}×${innerHeight} p=${document.documentElement.dataset.palette}`];
  if (vp) log.push(`transcript viewport: ${vp.clientWidth}×${vp.clientHeight}`);
  if (card) {
    const r = card.getBoundingClientRect();
    log.push(
      `card: ${Math.round(r.width)}×${Math.round(r.height)} (${Math.round((100 * r.height) / innerHeight)} % of the window); ` +
        `card scrolls: ${card.scrollHeight > card.clientHeight + 1} (${card.scrollHeight}/${card.clientHeight})`,
    );
    const scr = card.querySelector<HTMLElement>(".scr");
    if (scr) log.push(`inner box .scr scrolls: ${scr.scrollHeight > scr.clientHeight + 1} (${scr.scrollHeight}/${scr.clientHeight})`);
    const opts = card.querySelectorAll(".option, .opt");
    // Visible = inside the card's box and, when an inner box scrolls, inside that box too.
    const clip = scr && getComputedStyle(scr).overflowY !== "visible" ? scr.getBoundingClientRect() : r;
    const top = Math.max(r.top, clip.top);
    const bottom = Math.min(r.bottom, clip.bottom);
    const vis = [...opts].filter((o) => {
      const b = o.getBoundingClientRect();
      return b.bottom <= bottom + 0.5 && b.top >= top - 0.5 && b.height > 0;
    }).length;
    log.push(`option rows: ${opts.length}, fully visible in the card: ${vis}`);
  } else log.push("card: absent");
  if (q.get("act") === "1" && card) {
    const rows = [...card.querySelectorAll<HTMLElement>(".opt")];
    const answerBtn = [...card.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Answer");
    log.push(`Answer disabled before: ${answerBtn?.disabled}`);
    rows[1]?.click(); // a click on the row (the label), not on the radio
    await tick();
    log.push(`after the row click, Answer disabled: ${answerBtn?.disabled}; picked rows: ${card.querySelectorAll(".opt.on").length}`);
    rows[5]?.click(); // AVL tree
    rows[7]?.click(); // Priority queue
    rows[7]?.click(); // …untick
    rows[7]?.click(); // …tick again
    const other = card.querySelectorAll<HTMLInputElement>("input.other")[1];
    if (other) {
      other.value = "Trie";
      other.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await tick();
    log.push(`picked rows now: ${card.querySelectorAll(".opt.on").length}`);
    answerBtn?.click();
    await wait(300);
    const sent = approved[0] as { decision?: string; answer?: { answers?: unknown } } | undefined;
    log.push(`approve_call: ${sent ? `${sent.decision} ${JSON.stringify(sent.answer?.answers)}` : "not called"}`);
  }
  if (unknown.size) log.push(`unstubbed: ${[...unknown].join(", ")}`);
  if (q.get("cap") !== "0") cap.textContent += log.join("\n");
  else console.log(log.join("\n"));
  document.title = "ready";
}
void run();
