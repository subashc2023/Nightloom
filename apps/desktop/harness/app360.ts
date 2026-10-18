// Item 360 — the zoom audit's capture page (see app360.html). The real App over a stubbed backend; each ?v= puts
// one surface on screen the way the app gets there (state flags, or a real click where one is cheap).
import "@fontsource-variable/newsreader/wght.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "katex/dist/katex.min.css";
import "../src/app.css";
import { mount, flushSync, tick } from "svelte";
import App from "../src/App.svelte";
import { app, draftAside, openSession, showNote } from "../src/lib/state.svelte";
import { drop } from "../src/lib/dropLook.svelte";

const q = new URLSearchParams(location.search);
const v = q.get("v") ?? "chat";
const cap = document.getElementById("cap")!;
if (q.get("cap") === "1") cap.classList.add("on");
const unknown = new Set<string>();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
// The offscreen snapshot drops layers with a backdrop filter (drop362, 2026-10-15).
document.head.insertAdjacentHTML("beforeend", "<style>*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important} .toasts{display:none!important}</style>");

const project = {
  id: "p46",
  name: "ICS 46",
  root: "/Users/you/school/ics-46",
  notes_dir: "/Users/you/school/ics-46/.agents/notes",
  chats: 4,
  notes: 3,
  exists: true,
};
const ref = { id: project.id, name: project.name };
const sessions = [
  { id: "s1", title: "Project 2 — why the AVL tree rotates twice on a zig-zag insert", mode: "normal", kind: "build", modified: ago(3) },
  { id: "s2", title: "Lab 4 — cache simulator", mode: "normal", kind: "build", modified: ago(200) },
  { id: "s3", title: "Midterm topics", mode: "normal", kind: "chat", modified: ago(1500) },
  { id: "s4", title: "Office hours questions", mode: "incognito", kind: "chat", modified: ago(4000) },
];
const note = (name: string, min: number) => ({ name, bytes: 900, modified: ago(min), summary: name.replace(/\.md$/, "") });
const NOTE_TEXT = `# Course progress

Where ICS 46 stands, week by week. **Project 2** (AVL tree, hash map, priority queue) is due Friday.

## This week
- Finished the AVL insert; erase still double-rotates wrong on a zig-zag.
- Lab 4's cache simulator passes 11 of 14 tests.
- Read chapter 9 (heaps) — the sift-down proof is in \`heap-notes.md\`.

## Open questions
1. Does the hash map need to shrink on erase, or only grow?
2. Is \`std::optional\` allowed in the starter code?

| structure | tests | status |
|---|---|---|
| AVL tree | 18 | 15 pass |
| hash map | 12 | all pass |
| priority queue | 9 | not started |
`;

const at = ago(40);
const user = (text: string) => ({ event: "user_message", text, at });
const reply = (text: string, extra: unknown[] = []) => ({
  event: "assistant_message",
  model: "claude-opus-5-5",
  blocks: [{ type: "text", text }, ...extra],
  stop_reason: extra.length ? "tool_use" : "end_turn",
  usage: { input_tokens: 1200, output_tokens: 300 },
  at,
});
const LONG = `The insert lands in the **right subtree of the left child**, so a single right rotation would only move the imbalance across. The first rotation straightens the zig-zag and the second fixes the height.

\`\`\`cpp
Node* rotateLeftRight(Node* n) {
    n->left = rotateLeft(n->left);   // straighten the zig-zag
    return rotateRight(n);           // then fix the height
}
\`\`\`

Three things to check in your tree:

1. The heights are updated **bottom-up** after each rotation, child first.
2. \`balance(n)\` reads \`height(n->left) - height(n->right)\`, not the other way round.
3. The parent's pointer is re-linked to the subtree's new root.

| case | balance | child balance | rotations |
|---|---|---|---|
| left-left | +2 | ≥ 0 | right |
| left-right | +2 | < 0 | left, then right |
| right-right | −2 | ≤ 0 | left |
| right-left | −2 | > 0 | right, then left |

The height of a tree with $n$ nodes stays within $1.44 \\log_2 (n + 2)$, so every operation is $O(\\log n)$.`;
const QS = [
  "why does my AVL rotate twice on this insert?",
  "and what about erase — does it ever rotate more than once?",
  "can you check my rotateLeft against the lecture slides?",
  "what does the test in avl_tree_test.cpp line 88 actually check?",
  "is the height of an empty subtree -1 or 0 in the course's convention?",
  "ok — write me a checklist for debugging the erase case",
];
function chatEvents(n: number): unknown[] {
  const evs: unknown[] = [];
  for (let i = 0; i < n; i++) {
    evs.push(user(QS[i % QS.length]));
    evs.push(reply(i === n - 1 ? LONG : LONG.split("\n\n").slice(0, 2 + (i % 3)).join("\n\n")));
  }
  return evs;
}
const helpStyle = {
  question: "Earlier you told me to give nudges on ICS 46 work instead of full solutions. For these tests, which do you want?",
  header: "Help style",
  options: [
    { label: "Write the tests", description: "Full test bodies for every case; you read and run them." },
    { label: "Sketch the cases", description: "Names and one-line intents; you write the bodies." },
    { label: "Point at gaps", description: "Only say which behaviours have no test yet." },
  ],
};
const coverage = {
  question: "Which data structures should the extra tests cover?",
  header: "Coverage",
  multiSelect: true,
  options: [
    { label: "AVL tree", description: "rotations on insert and erase" },
    { label: "Hash map", description: "rehash and collisions" },
    { label: "Priority queue", description: "the binary heap" },
  ],
};

const proposals = [
  {
    project: ref,
    entry: { id: "pr1", proposal: { v: 1, at: ago(40), target: { kind: "project", id: ref.id, name: ref.name }, why: "Three chats this week asked for the course's height convention to be stated up front; the instructions now say so.", text: "…", from_dream: true } },
  },
  {
    project: null,
    entry: { id: "pr2", proposal: { v: 1, at: ago(300), target: { kind: "user" }, why: "You asked twice for answers without a recap paragraph; your memory now records it.", text: "…", from_dream: true } },
  },
];
const commits = [
  { project: ref, repo: project.root, hash: "a1b2c3d", at: ago(120), subject: "nightloom: dream — 2 notes", files: [{ path: "course-progress.md", added: 6, removed: 2 }] },
];

let chatN = v === "chat" || v === "aside" || v === "asidepanel" ? 8 : 2;
(window as unknown as { __stub: (c: string, a?: Record<string, unknown>) => Promise<unknown> }).__stub = async (cmd, args) => {
  if (q.get("log") === "1") console.log("stub", cmd);
  switch (cmd) {
    case "list_models":
      if (q.get("lm") === "null") return null;
      return args?.provider === "openai" ? ["gpt-5", "gpt-5-mini"] : ["claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5"];
    case "search_backends":
      return q.get("sb") === "null" ? null : [];
    case "list_projects":
      return [project];
    case "list_sessions":
      return sessions;
    case "open_session":
      return chatEvents(chatN);
    case "providers":
      if (q.get("prov") === "0") return [];
      return (q.get("prov") ? (x: unknown[]) => x.filter((_, i) => String(i) === q.get("prov")!.slice(1)) : (x: unknown[]) => x)([
        { kind: "anthropic", available: true, default_model: "claude-opus-5-5", key_source: "stored" },
        { kind: "openai", available: true, default_model: "gpt-5", key_source: "env" },
        { kind: "openrouter", available: false, default_model: null, key_source: null },
      ]);
    case "centre_proposals":
      return proposals;
    case "centre_dream_commits":
      return commits;
    case "list_notes":
      return (args?.scope === "project" ? [note("course-progress.md", 50), note("heap-notes.md", 400), note("midterm-topics.md", 900)] : []);
    case "read_note":
      return NOTE_TEXT;
    case "turn_usage":
    case "list_threads":
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
  // storage off
}
document.documentElement.dataset.palette = q.get("p") ?? "B";
mount(App, { target: document.getElementById("app")! });
flushSync();

async function run() {
  await wait(400);
  app.project = project as unknown as typeof app.project;
  app.sessions = sessions as unknown as typeof app.sessions;
  app.notes = [note("course-progress.md", 50), note("heap-notes.md", 400), note("midterm-topics.md", 900)] as typeof app.notes;
  app.vault = [note("reading-list.md", 3000)] as typeof app.vault;
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
  document.documentElement.dataset.palette = q.get("p") ?? "B";
  await tick();
  const log: string[] = [`v=${v} window=${innerWidth}×${innerHeight} dpr=${devicePixelRatio}`];

  if (v !== "welcome" && v !== "notes" && v !== "note") {
    if (v === "approve" || v === "ask" || v === "playwright") chatN = 1;
    await openSession("s1");
    await tick();
    await wait(300);
  }
  if (v === "approve" || v === "ask" || v === "playwright") {
    const req =
      v === "approve"
        ? { id: "toolu_b", name: "Bash", input: { command: "g++ -std=c++20 -Wall -Wextra -fsanitize=address,undefined tests/avl_tree_test.cpp src/avl_tree.cpp -o build/avl_test && ./build/avl_test --gtest_filter='AvlTree.*'", description: "Build and run the AVL tests" }, effect: "mutating" }
        : v === "ask"
          ? { id: "toolu_ask", name: "AskUserQuestion", input: { questions: [helpStyle, coverage] }, effect: "read_only" }
          : { id: "toolu_pw", name: "mcp__playwright__browser_navigate", input: { url: "https://canvas.eee.uci.edu/courses/46/assignments/project-2" }, effect: "mutating" };
    const evs = chatEvents(1) as Record<string, unknown>[];
    (evs[1] as { blocks: unknown[] }).blocks.push({ type: "tool_use", id: req.id, name: req.name, input: req.input });
    (evs[1] as { stop_reason: string }).stop_reason = "tool_use";
    app.events = evs as unknown as typeof app.events;
    app.busy = true;
    app.pendingApprovals = [req as unknown as (typeof app.pendingApprovals)[number]];
    await tick();
    await wait(400);
  }
  if (v === "aside" || v === "asidepanel") {
    const a = draftAside({ text: "a single right rotation would only move the imbalance across" } as unknown as Parameters<typeof draftAside>[0], null);
    if (a) {
      a.draft = false;
      const ANSWER =
        "Because the heavy grandchild sits on the **inner** side. A right rotation at the root moves the left child up, but its right subtree — the heavy one — is re-hung as the root's new left subtree, at the same depth it had. The tree is still off by two, now leaning right.\n\n- Rotate the child left first, and the zig-zag becomes a straight line.\n- Then one right rotation at the root balances it.";
      a.turns.push({ seq: 1, question: "why would one rotation only move it across?", partial: ANSWER, answer: ANSWER, error: null, cancelled: false, cacheRead: 120_000, model: "claude-opus-5-5", usage: { input_tokens: 122_000, output_tokens: 180, cache_read_tokens: 120_000 }, at: ago(2) });
      if (v === "asidepanel") {
        app.asidePanel = "s1";
        app.asidePanelThread = a.id;
      }
    }
    log.push(`aside: ${a ? a.id : "not drawn (engine?)"}`);
    await tick();
    await wait(300);
  }
  if (v === "notes") {
    app.leftTab = "notes";
  }
  if (v === "note") {
    showNote("project", "course-progress.md");
    await tick();
    await wait(400);
  }
  if (v === "bell") {
    const bell = document.querySelector<HTMLButtonElement>(".topbar .centre-bell");
    bell?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    bell?.click();
    log.push(`bell: ${!!bell}`);
  }
  if (v === "settings") {
    if (q.get("on")) app.settingsOpenOn = q.get("on") as typeof app.settingsOpenOn;
    app.showSettings = true;
  }
  if (v === "rail") app.showRail = true;
  if (v === "context") app.showContext = true;
  if (v === "drop") {
    drop.kind = "chat";
  }
  await tick();
  await wait(500);
  const vp = document.querySelector<HTMLElement>(".transcript");
  if (vp && v !== "chat") vp.scrollTop = vp.scrollHeight;
  if (vp && v === "chat") vp.scrollTop = Number(q.get("at") ?? 1) * (vp.scrollHeight - vp.clientHeight);
  vp?.dispatchEvent(new Event("scroll"));
  await wait(300);
  log.push(`drop.kind=${drop.kind}`);
  log.push(`stub unknown: ${[...unknown].slice(0, 12).join(", ")}`);
  cap.textContent += log.join("\n");
  document.title = "ready";
}
void run();
