// Backlog 354 harness — see ask354.html. The real App, the Tauri backend stubbed (unknown commands answer null),
// the Claude Code engine on, a short chat whose last reply calls AskUserQuestion, and that call waiting:
//   case=one       his ICS 46 "Help style" question, four options with descriptions
//   case=preview   a single-select question whose options carry the CLI's `preview`
//   case=multi     three questions: Help style, Coverage (multi-select), Compiler
//   case=answered  nothing waiting; the call has the CLI's result ("…answered: "Q"="A", …"), so the answered
//                  table is read back from it
// act=fill   (multi) picks Q1 by a "2" key, ticks two boxes of Q2, types into its Other, presses Q1's Next
// act=1      (multi) as fill, then a third pick and Answer; prints what reached `approve_call`, what was recorded,
//            and whether the answered table is drawn
// act=spy    (multi) scrolls the card to its end and back, printing the lit tab each time
// phone=1    the shared form alone (AskQuestions) in a 390-wide card like the phone's, with fill's answers
// The caption measures the card. cap=0 sends it to the console instead.
import "@fontsource-variable/newsreader/wght.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "../src/app.css";
import { mount, flushSync, tick } from "svelte";
import App from "../src/App.svelte";
import AskQuestions from "../src/lib/AskQuestions.svelte";
import { app } from "../src/lib/state.svelte";
import { recordedAnswers } from "../src/lib/askAnswers.svelte";
import type { AskQuestion } from "../src/lib/types";

const q = new URLSearchParams(location.search);
const which = q.get("case") ?? "multi";
const act = q.get("act");
const cap = document.getElementById("cap")!;
const unknown = new Set<string>();
const approved: unknown[] = [];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const helpStyle: AskQuestion = {
  question:
    "Earlier you told me to give nudges on ICS 46 work instead of full solutions. For these tests, which do you want?",
  header: "Help style",
  options: [
    { label: "Write the tests", description: "Full test bodies for every case; you read and run them." },
    { label: "Sketch the cases", description: "Names and one-line intents; you write the bodies." },
    { label: "Point at gaps", description: "Only say which behaviours have no test yet." },
    { label: "Nudge per test", description: "One hint at a time, as you write each one." },
  ],
};
const coverage: AskQuestion = {
  question: "Which data structures should the extra tests cover?",
  header: "Coverage",
  multiSelect: true,
  options: [
    { label: "AVL tree", description: "rotations on insert and erase" },
    { label: "Hash map", description: "rehash and collisions" },
    { label: "Priority queue", description: "the binary heap" },
  ],
};
const flags: AskQuestion = {
  question: "Which compiler flags should the tests build with?",
  header: "Compiler",
  options: [
    { label: "Match the Makefile", description: "-std=c++20 -Wall -Wextra, as the course ships it." },
    { label: "Add sanitizers", description: "Also -fsanitize=address,undefined to catch memory bugs." },
  ],
};
const layout: AskQuestion = {
  question: "How should the new test files be laid out?",
  header: "Test layout",
  options: [
    {
      label: "One file per structure",
      description: "Three files, each with its own fixture.",
      preview: "tests/\n  avl_tree_test.cpp\n  hash_map_test.cpp\n  priority_queue_test.cpp",
    },
    {
      label: "One file, in sections",
      description: "A single file; a banner comment per structure.",
      preview:
        "// tests/project2_test.cpp\n\n// ---- AVL tree ----\nTEST(AvlTree, InsertKeepsBalance) { … }\n\n// ---- Hash map ----\nTEST(HashMap, RehashKeepsKeys) { … }",
    },
    {
      label: "Match the starter layout",
      description: "Whatever the course's starter code already does.",
      preview: "gtest/\n  Project2Tests.cpp   ← add cases here\n  <b>not bold</b> (drawn as text, never HTML)",
    },
  ],
};
const QS: Record<string, AskQuestion[]> = {
  one: [helpStyle],
  preview: [layout],
  multi: [helpStyle, coverage, flags],
  answered: [helpStyle, coverage, flags],
};
const questions = QS[which] ?? QS.multi;

// ---- phone=1: the shared form alone, in a card like the phone's --------------------------------------------
if (q.get("phone") === "1") {
  document.documentElement.dataset.palette = q.get("p") ?? "B";
  document.body.style.cssText = "margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans)";
  const root = document.getElementById("app")!;
  root.innerHTML = `<div style="padding:14px 12px;display:flex;flex-direction:column;gap:12px">
      <div style="align-self:flex-end;background:var(--well);border-radius:16px;padding:8px 13px;font-size:15px">add tests for project 2</div>
      <div style="font-size:15px;line-height:1.55">Before I start, three questions about the tests.</div>
      <section id="pc" style="background:var(--sheet);border:1px solid var(--line2);border-radius:16px;padding:4px 14px 14px;display:flex;flex-direction:column;gap:12px"></section>
    </div>`;
  const st = $state<{ picks: Record<number, string[]>; others: Record<number, string> }>({
    picks: which === "multi" ? { 0: ["Sketch the cases"], 1: ["AVL tree", "Priority queue"] } : which === "preview" ? { 0: ["One file, in sections"] } : {},
    others: which === "multi" ? { 1: "the skip list from lab 5" } : {},
  });
  const card = document.getElementById("pc")!;
  mount(AskQuestions, {
    target: card,
    props: {
      questions,
      idBase: "phone",
      get picks() {
        return st.picks;
      },
      get others() {
        return st.others;
      },
      ontoggle: (i: number, label: string, multi: boolean) => {
        const cur = st.picks[i] ?? [];
        st.picks[i] = multi ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label];
      },
      onother: (i: number, v: string) => {
        st.others[i] = v;
      },
    },
  });
  card.insertAdjacentHTML(
    "beforeend",
    `<input type="text" placeholder="A note (goes as your next message)" style="font:inherit;font-size:15px;background:var(--paper);color:var(--ink);border:1px solid var(--line2);border-radius:10px;padding:9px 11px" />
     <div style="display:flex;gap:8px"><button class="btn accent" style="min-height:44px;padding:0 18px;border-radius:12px;border:0;background:var(--accent);color:var(--paper);font:inherit;font-weight:600">Answer</button><button class="btn" style="min-height:44px;padding:0 18px;border-radius:12px;border:1px solid var(--line2);background:transparent;color:var(--ink);font:inherit">Skip</button></div>`,
  );
  document.title = "ready";
} else {
  void runApp();
}

// ---- the real App -------------------------------------------------------------------------------------------
async function runApp() {
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
  (window as unknown as { __stub: (c: string, a?: Record<string, unknown>) => Promise<unknown> }).__stub = async (
    cmd,
    a,
  ) => {
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
  } catch {
    // Storage off.
  }
  document.documentElement.dataset.palette = q.get("p") ?? "B";
  mount(App, { target: document.getElementById("app")! });
  flushSync();
  await wait(400);

  const input = { questions };
  app.project = project as unknown as typeof app.project;
  app.sessions = sessions as unknown as typeof app.sessions;
  app.connection = { ...(app.connection ?? {}), engine: "claude-code" } as unknown as typeof app.connection;
  const at = ago(10);
  const lead = which === "one" || which === "preview" ? "One thing first." : "Before I start, three questions about the tests.";
  const events: unknown[] = [
    { event: "user_message", text: "add tests for project 2", at },
    {
      event: "assistant_message",
      model: "claude-opus-5-5",
      blocks: [
        { type: "text", text: lead },
        { type: "tool_use", id: "toolu_ask", name: "AskUserQuestion", input },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 1200, output_tokens: 40 },
      at,
    },
  ];
  if (which === "answered") {
    events.push({
      event: "tool_result",
      tool_use_id: "toolu_ask",
      name: "AskUserQuestion",
      content: `Your questions have been answered: "${helpStyle.question}"="Sketch the cases", "${coverage.question}"="AVL tree, Priority queue, the skip list from lab 5", "${flags.question}"="Match the Makefile". You can now continue with the user's answers in mind.`,
      is_error: false,
      at,
    });
    events.push({
      event: "assistant_message",
      model: "claude-opus-5-5",
      blocks: [
        {
          type: "text",
          text: "Sketching the cases for the AVL tree, the priority queue and the skip list from lab 5 — names and one-line intents only, so you write the bodies.",
        },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 1300, output_tokens: 60 },
      at,
    });
  }
  app.events = events as unknown as typeof app.events;
  if (which !== "answered") {
    app.busy = true;
    app.pendingApprovals = [
      { id: "toolu_ask", name: "AskUserQuestion", input, effect: "read_only" } as unknown as (typeof app.pendingApprovals)[number],
    ];
  }
  await tick();
  await wait(500);
  const vp = document.querySelector<HTMLElement>(".transcript");
  if (vp) vp.scrollTop = vp.scrollHeight;
  await wait(200);

  const log: string[] = [`case=${which} act=${act ?? "-"} window=${innerWidth}×${innerHeight}`];
  const card = document.querySelector<HTMLElement>(".ask.qcard");
  const litTab = () => document.querySelector(".aq-tab.on")?.textContent?.trim() ?? "(none)";
  const secs = () => [...document.querySelectorAll<HTMLElement>(".aq-q")];
  if (card) {
    const r = card.getBoundingClientRect();
    log.push(
      `card: ${Math.round(r.width)}×${Math.round(r.height)}; scrolls: ${card.scrollHeight > card.clientHeight + 1} (${card.scrollHeight}/${card.clientHeight}); tabs: ${document.querySelectorAll(".aq-tab").length}; questions: ${secs().length}; previews: ${document.querySelectorAll(".aq-prev").length}`,
    );
    const pre = document.querySelector(".aq-prev pre");
    if (pre) log.push(`preview shows: ${JSON.stringify(pre.textContent?.slice(0, 40))}; HTML tags parsed inside: ${pre.querySelectorAll("*").length}`);
  } else log.push("card: absent");

  async function fill() {
    // "2" on question 1 picks its second option, as a number key does.
    const s0 = secs()[0];
    const r0 = s0?.querySelector<HTMLInputElement>("input.aq-in");
    r0?.focus({ preventScroll: true });
    r0?.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
    await tick();
    log.push(`after "2": picked in Q1: ${s0?.querySelectorAll(".aq-opt.on").length} (${s0?.querySelector(".aq-opt.on .aq-ol")?.textContent})`);
    // Next under Q1 → Q2 comes up, its tab lit.
    s0?.querySelector<HTMLButtonElement>(".aq-next")?.click();
    await wait(700);
    log.push(`after Next: lit tab "${litTab()}"; focus in Q2: ${secs()[1]?.contains(document.activeElement)}`);
    const rows = [...(secs()[1]?.querySelectorAll<HTMLElement>(".aq-opt:not(.aq-other)") ?? [])];
    rows[0]?.click(); // a click on the row (the label), not on the box
    rows[2]?.click();
    const other = secs()[1]?.querySelector<HTMLInputElement>("input.aq-otherin");
    if (other) {
      other.focus({ preventScroll: true });
      other.value = "the skip list from lab 5";
      other.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await tick();
    log.push(`Q2 ticked: ${secs()[1]?.querySelectorAll(".aq-opt.on").length} (two boxes + Other)`);
    log.push(`tabs answered: ${document.querySelectorAll(".aq-tab.ok").length} of ${document.querySelectorAll(".aq-tab").length}`);
  }

  if (card && (act === "fill" || act === "1")) await fill();
  if (card && act === "1") {
    const s2 = secs()[2];
    s2?.querySelector<HTMLElement>(".aq-opt")?.click();
    await tick();
    const answerBtn = [...card.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Answer");
    log.push(`Answer disabled: ${answerBtn?.disabled}`);
    answerBtn?.click();
    await wait(400);
    const sent = approved[0] as { decision?: string; answer?: { answers?: unknown } } | undefined;
    log.push(`approve_call: ${sent ? `${sent.decision} ${JSON.stringify(sent.answer?.answers)}` : "not called"}`);
    log.push(`recorded rows: ${JSON.stringify(recordedAnswers("toolu_ask")?.rows.map((r) => [r.header, r.answer]))}`);
    // The prompt resolved; the answered table should now sit under the call.
    app.pendingApprovals = [];
    await tick();
    await wait(200);
    log.push(`answered table drawn: ${!!document.querySelector(".aa")}; rows: ${document.querySelectorAll(".aa-table tr").length}`);
  }
  if (card && act === "spy") {
    log.push(`lit at start: "${litTab()}"`);
    card.scrollTop = card.scrollHeight;
    card.dispatchEvent(new Event("scroll"));
    await wait(150);
    log.push(`card scrolled to its end (${card.scrollTop}): lit "${litTab()}"`);
    const s1 = secs()[1];
    card.scrollTop += s1.getBoundingClientRect().top - card.getBoundingClientRect().top - 40;
    card.dispatchEvent(new Event("scroll"));
    await wait(150);
    log.push(`card scrolled to Q2 (${card.scrollTop}): lit "${litTab()}"`);
    card.scrollTop = 0;
    card.dispatchEvent(new Event("scroll"));
    await wait(150);
    log.push(`card scrolled to the top: lit "${litTab()}"`);
  }
  if (which === "answered")
    log.push(`answered table drawn: ${!!document.querySelector(".aa")}; rows: ${document.querySelectorAll(".aa-table tr").length}`);
  if (unknown.size) log.push(`unstubbed: ${unknown.size} commands`);
  if (q.get("cap") !== "0") cap.textContent += log.join("\n");
  else console.log(log.join("\n"));
  document.title = "ready";
}
