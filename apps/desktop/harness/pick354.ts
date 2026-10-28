// Item 354 — three whole looks of the AskUserQuestion card for his pick (see pick354.html).
// Static HTML in the app's real tokens and fonts; nothing is wired. Every look draws the same three scenes from
// the same data, so the looks differ only in design:
//   one       a single question whose options carry previews (the CLI's option `preview`, inferred), one picked
//   several   three questions: the first answered, the second (multi-select) open with two ticks and "Other"
//             being typed, the third still open
//   answered  the card after Answer, folded in the transcript, the turn carrying on below it
// Every look keeps what answering has today: per-question Other, the optional note for the model, Answer, and
// "Skip — let it decide".
import "@fontsource-variable/newsreader/wght.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "../src/app.css";

type Opt = { label: string; description?: string; preview?: string };
type Q = { header: string; question: string; multi?: boolean; options: Opt[] };
type Scene = "one" | "several" | "answered";
type Look = "A" | "B" | "C";
type Data = {
  qs: Q[];
  picks: Record<number, string[]>;
  other: Record<number, string>;
  active: number; // the question in hand (B: the tab, C: the one asked now)
  typing: number | null; // whose Other has the caret
  note: string;
  done: boolean;
};

const q = new URLSearchParams(location.search);
const SCENES: Scene[] = ["one", "several", "answered"];
let scene: Scene = (SCENES as string[]).includes(q.get("scene") ?? "") ? (q.get("scene") as Scene) : "several";
const only = q.get("look") as Look | null;
if (q.get("palette")) document.documentElement.dataset.palette = q.get("palette")!;

const LAYOUT: Q = {
  header: "Test layout",
  question: "How should the new test files be laid out?",
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
        "// tests/project2_test.cpp\n\n// ---- AVL tree ---------------\nTEST(AvlTree, InsertKeepsBalance) { … }\n\n// ---- Hash map ---------------\nTEST(HashMap, RehashKeepsKeys) { … }",
    },
    {
      label: "Match the starter layout",
      description: "Whatever the course's starter code already does.",
      preview: "gtest/\n  Project2Tests.cpp   ← add cases here\n  (the starter has one file)",
    },
  ],
};
const HELP: Q = {
  header: "Help style",
  question:
    "Earlier you told me to give nudges on ICS 46 work instead of full solutions. For these tests, which do you want?",
  options: [
    { label: "Write the tests", description: "Full test bodies for every case; you read and run them." },
    { label: "Sketch the cases", description: "Names and one-line intents; you write the bodies." },
    { label: "Point at gaps", description: "Only say which behaviours have no test yet." },
    { label: "Nudge per test", description: "One hint at a time, as you write each one." },
  ],
};
const COVER: Q = {
  header: "Coverage",
  question: "Which data structures should the extra tests cover?",
  multi: true,
  options: [
    { label: "AVL tree", description: "rotations on insert and erase" },
    { label: "Hash map", description: "rehash and collisions" },
    { label: "Priority queue", description: "the binary heap" },
  ],
};
const FLAGS: Q = {
  header: "Compiler",
  question: "Which compiler flags should the tests build with?",
  options: [
    { label: "Match the Makefile", description: "-std=c++20 -Wall -Wextra, as the course ships it." },
    { label: "Add sanitizers", description: "Also -fsanitize=address,undefined to catch memory bugs." },
  ],
};

function data(s: Scene): Data {
  switch (s) {
    case "one":
      return {
        qs: [LAYOUT],
        picks: { 0: ["One file, in sections"] },
        other: {},
        active: 0,
        typing: null,
        note: "",
        done: false,
      };
    case "several":
      return {
        qs: [HELP, COVER, FLAGS],
        picks: { 0: ["Sketch the cases"], 1: ["AVL tree", "Priority queue"] },
        other: { 1: "the skip list from lab 5" },
        active: 1,
        typing: 1,
        note: "",
        done: false,
      };
    case "answered":
      return {
        qs: [HELP, COVER, FLAGS],
        picks: { 0: ["Sketch the cases"], 1: ["AVL tree", "Priority queue"], 2: ["Match the Makefile"] },
        other: { 1: "the skip list from lab 5" },
        active: 2,
        typing: null,
        note: "keep the hints short",
        done: true,
      };
  }
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const isOn = (d: Data, i: number, l: string) => (d.picks[i] ?? []).includes(l);
const hasAnswer = (d: Data, i: number) => (d.picks[i]?.length ?? 0) > 0 || (d.other[i] ?? "").trim() !== "";
const answerOf = (d: Data, i: number) => [...(d.picks[i] ?? []), ...(d.other[i] ? [d.other[i]] : [])];
const openCount = (d: Data) => d.qs.filter((_, i) => !hasAnswer(d, i)).length;
const caret = `<span class="caret"></span>`;
const CHECK = `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// ---- Look A · Inline: the question reads as part of Claude's reply; no box, a copper rule ------------------
function lookA(d: Data): string {
  const n = d.qs.length;
  if (d.done)
    return `<div class="a-done">
      <div class="a-done-head"><span class="a-tick">${CHECK}</span>You answered ${n === 1 ? "Claude's question" : `${n} questions`}<span class="sp"></span><button class="a-quiet">Show</button></div>
      ${d.qs
        .map(
          (qq, i) =>
            `<div class="a-done-row"><span class="a-done-h">${esc(qq.header)}</span><span class="a-done-v">${answerOf(d, i)
              .map(esc)
              .join(", ")}</span></div>`,
        )
        .join("")}
      ${d.note ? `<div class="a-done-row"><span class="a-done-h">Note</span><span class="a-done-v dim">${esc(d.note)}</span></div>` : ""}
    </div>`;
  const qhtml = d.qs
    .map((qq, i) => {
      if (n > 1 && hasAnswer(d, i) && i !== d.active)
        return `<div class="a-q-folded"><span class="a-tick">${CHECK}</span><span class="a-done-h">${esc(qq.header)}</span><span class="a-done-v">${answerOf(
          d,
          i,
        )
          .map(esc)
          .join(", ")}</span><span class="sp"></span><button class="a-quiet">Change</button></div>`;
      const opts = qq.options
        .map((o, k) => {
          const on = isOn(d, i, o.label);
          return `<div class="a-opt${on ? " on" : ""}">
            <span class="a-mk ${qq.multi ? "sq" : "rd"}">${on ? (qq.multi ? CHECK : "<i></i>") : ""}</span>
            <span class="a-ot"><span class="a-ol">${esc(o.label)}</span>${o.description ? `<span class="a-od">${esc(o.description)}</span>` : ""}</span>
            <kbd class="a-k">${k + 1}</kbd>
          </div>${on && o.preview ? `<pre class="a-prev">${esc(o.preview)}</pre>` : ""}`;
        })
        .join("");
      const ot = d.other[i] ?? "";
      const other = `<div class="a-opt a-other${ot ? " on" : ""}">
          <span class="a-mk ${qq.multi ? "sq" : "rd"}">${ot ? (qq.multi ? CHECK : "<i></i>") : ""}</span>
          <span class="a-ot">${ot ? `<span class="a-od">Other</span>` : ""}<span class="a-in${ot ? "" : " ph"}">${ot ? esc(ot) : "Something else — type it"}${d.typing === i ? caret : ""}</span></span>
          <kbd class="a-k">${qq.options.length + 1}</kbd>
        </div>`;
      return `<div class="a-q">
        <div class="a-h">${n > 1 ? `${i + 1} · ` : ""}${esc(qq.header)}${qq.multi ? ` <span class="a-any">pick any</span>` : ""}</div>
        <div class="a-text">${esc(qq.question)}</div>
        <div class="a-opts">${opts}${other}</div>
      </div>`;
    })
    .join("");
  const open = openCount(d);
  return `<div class="a-ask">
    <div class="a-kick"><span class="a-dot"></span>Claude is waiting on ${n === 1 ? "your answer" : `${n} answers`}${n > 1 ? ` · ${open === 0 ? "all answered" : `${open} still open`}` : ""}</div>
    ${qhtml}
    <div class="a-foot">
      <input class="a-note" placeholder="Note for Claude — optional" value="${esc(d.note)}" />
      <div class="a-bar">
        <button class="a-send${open ? " off" : ""}">Answer <kbd>⏎</kbd></button>
        <button class="a-skip">Skip — let Claude decide</button>
      </div>
    </div>
  </div>`;
}

// ---- Look B · Tabs: one question at a time in a card, a tab per question, tiles for options ----------------
function lookB(d: Data): string {
  const n = d.qs.length;
  if (d.done)
    return `<div class="b-card b-done">
      <div class="b-done-head"><span class="b-chip done">${CHECK} Answered</span><span class="b-sub">${n === 1 ? "1 question" : `${n} questions`} · 2:41 PM</span><span class="sp"></span><button class="b-ghost">Show questions</button></div>
      <table class="b-table">${d.qs
        .map(
          (qq, i) =>
            `<tr><th>${esc(qq.header)}</th><td>${answerOf(d, i)
              .map((a) => `<span class="b-ans">${esc(a)}</span>`)
              .join("")}</td></tr>`,
        )
        .join("")}${d.note ? `<tr><th>Note</th><td class="dim">${esc(d.note)}</td></tr>` : ""}</table>
    </div>`;
  const i = d.active;
  const qq = d.qs[i];
  const tabs =
    n > 1
      ? `<nav class="b-tabs">${d.qs
          .map(
            (t, k) =>
              `<button class="${k === i ? "on" : ""}${hasAnswer(d, k) ? " ok" : ""}"><span class="b-tm">${hasAnswer(d, k) ? CHECK : k + 1}</span>${esc(t.header)}</button>`,
          )
          .join("")}<button class="b-review">Review</button></nav>`
      : `<div class="b-single"><span class="b-qm">?</span>Claude asks · ${esc(qq.header)}</div>`;
  const hasPrev = qq.options.some((o) => o.preview);
  const tiles = qq.options
    .map((o, k) => {
      const on = isOn(d, i, o.label);
      return `<button class="b-tile${on ? " on" : ""}">
        <span class="b-num">${qq.multi ? (on ? CHECK : "") : k + 1}</span>
        <span class="b-tt"><span class="b-tl">${esc(o.label)}</span>${o.description ? `<span class="b-td">${esc(o.description)}</span>` : ""}</span>
      </button>`;
    })
    .join("");
  const ot = d.other[i] ?? "";
  const other = `<div class="b-tile b-other${ot ? " on" : ""}${d.typing === i ? " focus" : ""}"><span class="b-num">${qq.multi ? (ot ? CHECK : "") : qq.options.length + 1}</span><span class="b-tt">${ot ? `<span class="b-td">Other</span>` : ""}<span class="b-in${ot ? "" : " ph"}">${ot ? esc(ot) : "Other — type your own answer"}${d.typing === i ? caret : ""}</span></span></div>`;
  const picked = qq.options.find((o) => isOn(d, i, o.label));
  const body = hasPrev
    ? `<div class="b-split"><div class="b-list">${tiles}${other}</div><div class="b-pane"><div class="b-pane-h">Preview · ${esc(picked?.label ?? qq.options[0].label)}</div><pre>${esc(
        (picked ?? qq.options[0]).preview ?? "",
      )}</pre></div></div>`
    : `<div class="b-grid${qq.multi ? " multi" : ""}">${tiles}${other}</div>`;
  const open = openCount(d);
  return `<div class="b-card">
    ${tabs}
    <div class="b-body">
      <div class="b-text">${esc(qq.question)}</div>
      ${qq.multi ? `<div class="b-hint">Pick any that apply</div>` : ""}
      ${body}
    </div>
    <div class="b-foot">
      <button class="b-add">+ Note for Claude</button>
      <span class="sp"></span>
      <button class="b-ghost">Skip — let Claude decide</button>
      ${n > 1 ? `<button class="b-ghost">← Back</button>` : ""}
      ${
        n > 1 && i < n - 1
          ? `<button class="b-go">Next <kbd>⇥</kbd></button>`
          : `<button class="b-go${open ? " off" : ""}">Answer <kbd>⏎</kbd></button>`
      }
    </div>
  </div>`;
}

// ---- Look C · Conversation: Claude asks in the transcript's own voice; you reply with chips, one at a time --
function lookC(d: Data): string {
  const n = d.qs.length;
  const me = (txt: string, small = "") =>
    `<div class="c-me"><div class="c-bubble">${txt}</div>${small ? `<div class="c-at">${small}</div>` : ""}</div>`;
  const asked = (qq: Q, i: number) =>
    `<div class="c-q"><span class="c-tag">${n > 1 ? `${i + 1} of ${n} · ` : ""}${esc(qq.header)}</span><div class="c-text">${esc(qq.question)}</div></div>`;
  if (d.done)
    return `<div class="c-flow c-past">
      <div class="c-done-head"><span class="c-tick">${CHECK}</span>Claude asked ${n === 1 ? "a question" : `${n} questions`}<span class="sp"></span><button class="c-link">Show</button></div>
      ${me(
        d.qs
          .map(
            (qq, i) =>
              `<div class="c-pair"><span class="c-ph">${esc(qq.header)}</span>${answerOf(d, i).map(esc).join(", ")}</div>`,
          )
          .join("") + (d.note ? `<div class="c-pair"><span class="c-ph">Note</span><i>${esc(d.note)}</i></div>` : ""),
        "sent 2:41 PM",
      )}
    </div>`;
  const parts: string[] = [];
  for (let i = 0; i < d.active; i++) {
    parts.push(asked(d.qs[i], i));
    parts.push(me(answerOf(d, i).map(esc).join(", "), `<button class="c-link">Change</button>`));
  }
  const i = d.active;
  const qq = d.qs[i];
  parts.push(asked(qq, i));
  const picked = qq.options.find((o) => isOn(d, i, o.label));
  if (qq.options.some((o) => o.preview)) {
    const k = picked ? qq.options.indexOf(picked) : 0;
    parts.push(`<div class="c-prev"><div class="c-prev-h"><button>‹</button><span>${esc(qq.options[k].label)}</span><span class="sp"></span><span class="c-pg">${k + 1} / ${qq.options.length}</span><button>›</button></div><pre>${esc(
      qq.options[k].preview ?? "",
    )}</pre></div>`);
  }
  const ot = d.other[i] ?? "";
  const chips = qq.options
    .map((o) => {
      const on = isOn(d, i, o.label);
      return `<button class="c-chip${on ? " on" : ""}">${qq.multi ? `<span class="c-box">${on ? CHECK : ""}</span>` : ""}${esc(o.label)}</button>`;
    })
    .join("");
  const otherChip =
    ot || d.typing === i
      ? `<span class="c-chip c-typing on">${qq.multi ? `<span class="c-box">${CHECK}</span>` : ""}<span class="c-ol">Other</span>${esc(ot)}${d.typing === i ? caret : ""}</span>`
      : `<button class="c-chip c-otherb">Other…</button>`;
  const desc = (picked ?? qq.options[0]).description;
  parts.push(`<div class="c-reply">
    <div class="c-chips">${chips}${otherChip}</div>
    ${!qq.multi && desc ? `<div class="c-desc"><b>${esc((picked ?? qq.options[0]).label)}</b> — ${esc(desc)}</div>` : ""}
    ${qq.multi ? `<div class="c-desc">${qq.options.map((o) => `<b>${esc(o.label)}</b> ${esc(o.description ?? "")}`).join(" · ")}</div>` : ""}
    <div class="c-row">
      ${
        qq.multi || i === n - 1
          ? `<button class="c-go${hasAnswer(d, i) ? "" : " off"}">${i === n - 1 ? "Send answer" : "Done"} <kbd>⏎</kbd></button>`
          : `<span class="c-fine">a tap answers and moves on</span>`
      }
      <span class="sp"></span>
      <button class="c-link">Add a note</button>
      <button class="c-link">Skip — let Claude decide</button>
    </div>
  </div>`);
  return `<div class="c-flow">${parts.join("")}</div>`;
}

const LOOKS: [Look, string, string, (d: Data) => string][] = [
  ["A", "Inline", "part of Claude's reply; every question open at once, answered ones fold to a line", lookA],
  ["B", "Tabs", "a card; one question per tab, options as tiles, previews in a side pane", lookB],
  ["C", "Conversation", "Claude asks one at a time; you reply with chips, your answers become your bubbles", lookC],
];

function chat(look: (d: Data) => string, s: Scene): string {
  const d = data(s);
  const lead =
    s === "one"
      ? "I'll add tests for the three structures. One thing first."
      : "Before I start, three questions about the tests.";
  const after =
    s === "answered"
      ? `<div class="t-msg">Sketching the cases for the AVL tree, the priority queue and the skip list from lab 5 — names and one-line intents only, so you write the bodies.</div>
         <div class="t-tool"><span class="t-dot"></span>Read gtest/Project2Tests.cpp</div>`
      : "";
  return `<div class="t-col">
      <div class="t-me">add tests for project 2</div>
      <div class="t-msg">${lead}</div>
      ${look(d)}
      ${after}
    </div>
    <div class="t-comp"><div class="t-box">${s === "answered" ? "Message…" : "Claude waits for your answer — or type to reply instead"}</div></div>`;
}

function render() {
  const root = document.getElementById("root")!;
  const looks = LOOKS.filter(([l]) => !only || l === only);
  root.innerHTML = `<header class="pick-head">
      <h1>Pick a question card — reply with a letter</h1>
      <nav>${SCENES.map(
        (s) =>
          `<button data-s="${s}" class="${s === scene ? "on" : ""}">${s === "one" ? "one question, previews" : s === "several" ? "several, multi-select, Other" : "answered"}</button>`,
      ).join("")}</nav>
    </header>
    <main class="pick-grid${only ? " solo" : ""}">${looks
      .map(
        ([l, name, what, f]) => `<section>
        <h2>${l} · ${name} <span>— ${what}</span></h2>
        <div class="win">${only ? `<div class="side"><div class="side-i on">Chats</div><div class="side-i">Notes</div><div class="side-i">Nightshift</div><div class="side-chat">Project 2 tests</div></div>` : ""}<div class="tr">${chat(f, scene)}</div></div>
      </section>`,
      )
      .join("")}</main>`;
  for (const b of root.querySelectorAll<HTMLButtonElement>("nav button"))
    b.onclick = () => {
      scene = b.dataset.s as Scene;
      render();
    };
}

const css = `
html, body { overflow: auto; height: auto; min-height: 100%; }
body { font-family: var(--sans); background: var(--paper); color: var(--ink); }
.sp { flex: 1; }
.dim { color: var(--dim); }
button { font-family: inherit; }
input { font-family: inherit; }
kbd { font-family: var(--mono); font-size: 10.5px; opacity: 0.75; }
pre { margin: 0; }
.caret { display: inline-block; width: 1.5px; height: 1.05em; background: var(--accent); vertical-align: -0.15em; margin-left: 1px; }

.pick-head { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--line); }
.pick-head h1 { font-size: 15px; margin: 0; font-weight: 600; }
.pick-head nav { display: flex; gap: 6px; flex-wrap: wrap; }
.pick-head nav button { font-size: 12.5px; padding: 4px 11px; border-radius: 999px; border: 1px solid var(--line2); background: transparent; color: var(--ink2); cursor: pointer; }
.pick-head nav button.on { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-ink); }
.pick-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(440px, 1fr)); gap: 10px; padding: 10px; }
.pick-grid section { display: flex; flex-direction: column; min-width: 0; }
.pick-grid h2 { margin: 0 0 6px; font-size: 13.5px; font-weight: 600; }
.pick-grid h2 span { font-weight: 400; color: var(--dim); }
.win { display: flex; height: calc(100vh - 104px); min-height: 640px; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: var(--paper); }
.side { width: 220px; flex-shrink: 0; background: var(--sheet); border-right: 1px solid var(--line); padding: 12px 8px; display: flex; flex-direction: column; gap: 2px; font-size: 13.5px; color: var(--ink2); }
.side-i { padding: 6px 10px; border-radius: 7px; }
.side-i.on { background: var(--well); color: var(--ink); }
.side-chat { margin-top: 14px; padding: 6px 10px; font-size: 13px; color: var(--ink); border-left: 2px solid var(--accent); }
.tr { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.t-col { flex: 1; min-height: 0; overflow-y: auto; width: 100%; max-width: 760px; margin: 0 auto; box-sizing: border-box; padding: 20px 22px 12px; display: flex; flex-direction: column; gap: 14px; }
.t-me { align-self: flex-end; background: var(--well); border: 1px solid var(--line2); border-radius: 14px 14px 4px 14px; padding: 7px 12px; font-size: 14px; }
.t-msg { font-size: 15px; line-height: 1.6; color: var(--ink); }
.t-tool { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--dim); font-family: var(--mono); }
.t-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--live); }
.t-comp { padding: 8px 22px 14px; max-width: 760px; width: 100%; margin: 0 auto; box-sizing: border-box; }
.t-box { border: 1px solid var(--line2); border-radius: 12px; padding: 12px 14px 26px; font-size: 14px; color: var(--dim); background: var(--sheet); }

/* ---- A · Inline ---- */
.a-ask { border-left: 2px solid var(--accent); padding: 2px 0 2px 16px; display: flex; flex-direction: column; gap: 18px; }
.a-kick { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--accent-ink); }
.a-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.a-q { display: flex; flex-direction: column; gap: 8px; }
.a-h { font-size: 11px; letter-spacing: 0.07em; text-transform: uppercase; color: var(--dim); font-weight: 500; }
.a-any { text-transform: none; letter-spacing: 0; color: var(--accent-ink); margin-left: 4px; }
.a-text { font-family: var(--serif); font-size: 18.5px; line-height: 1.45; color: var(--ink); }
.a-opts { display: flex; flex-direction: column; gap: 1px; margin-left: -8px; }
.a-opt { display: flex; align-items: flex-start; gap: 11px; padding: 7px 8px; border-radius: 8px; cursor: pointer; }
.a-opt:hover { background: var(--well); }
.a-opt.on { background: color-mix(in srgb, var(--accent-soft) 70%, transparent); }
.a-mk { flex-shrink: 0; width: 16px; height: 16px; margin-top: 2px; border: 1.5px solid var(--line2); display: grid; place-items: center; box-sizing: border-box; color: var(--paper); }
.a-mk.rd { border-radius: 50%; }
.a-mk.sq { border-radius: 4px; }
.a-opt.on .a-mk { border-color: var(--accent); background: var(--accent); }
.a-mk.rd i { width: 6px; height: 6px; border-radius: 50%; background: var(--paper); }
.a-ot { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.a-ol { font-size: 14.5px; color: var(--ink); line-height: 1.4; }
.a-opt.on .a-ol { color: var(--accent-ink); }
.a-od { font-size: 12.5px; color: var(--dim); line-height: 1.4; }
.a-k { flex-shrink: 0; color: var(--dim); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; margin-top: 2px; }
.a-in { font-size: 14.5px; color: var(--ink); border-bottom: 1px solid var(--accent); padding-bottom: 2px; line-height: 1.4; }
.a-in.ph { color: var(--dim); border-bottom-color: var(--line2); }
.a-prev { margin: 2px 0 6px 35px; font-family: var(--mono); font-size: 12px; line-height: 1.6; color: var(--ink2); background: var(--term); border: 1px solid var(--line); border-radius: 8px; padding: 9px 12px; white-space: pre-wrap; }
.a-q-folded { display: flex; align-items: center; gap: 10px; font-size: 13.5px; padding: 2px 0; }
.a-tick { width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; background: var(--done-soft); color: var(--done); flex-shrink: 0; }
.a-done-h { font-size: 11px; letter-spacing: 0.07em; text-transform: uppercase; color: var(--dim); min-width: 84px; }
.a-done-v { color: var(--ink); font-size: 13.5px; }
.a-quiet { background: none; border: 0; color: var(--dim); font-size: 12px; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.a-foot { display: flex; flex-direction: column; gap: 10px; }
.a-note { background: transparent; border: 0; border-bottom: 1px solid var(--line2); color: var(--ink); font-size: 13px; padding: 4px 0; outline: none; }
.a-note::placeholder { color: var(--dim); }
.a-bar { display: flex; align-items: center; gap: 14px; }
.a-send { background: var(--accent); color: var(--paper); border: 0; border-radius: 8px; padding: 7px 16px; font-size: 13.5px; font-weight: 600; cursor: pointer; }
.a-send kbd { opacity: 0.8; margin-left: 4px; }
.a-send.off { background: var(--well); color: var(--dim); }
.a-skip { background: none; border: 0; color: var(--ink2); font-size: 13px; cursor: pointer; }
.a-done { border-left: 2px solid var(--done); padding: 2px 0 2px 16px; display: flex; flex-direction: column; gap: 6px; }
.a-done-head { display: flex; align-items: center; gap: 10px; font-size: 13.5px; color: var(--ink2); margin-bottom: 2px; }
.a-done-row { display: flex; gap: 10px; align-items: baseline; padding-left: 28px; }

/* ---- B · Tabs ---- */
.b-card { background: var(--sheet); border: 1px solid var(--line2); border-radius: 12px; overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,0.25); }
.b-tabs { scrollbar-width: none; display: flex; gap: 2px; padding: 6px 8px 0; border-bottom: 1px solid var(--line); overflow-x: auto; }
.b-tabs button { display: flex; align-items: center; gap: 7px; background: none; border: 0; border-bottom: 2px solid transparent; color: var(--dim); font-size: 13px; padding: 8px 10px 9px; cursor: pointer; white-space: nowrap; }
.b-tabs button.on { color: var(--ink); border-bottom-color: var(--accent); }
.b-tm { width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; font-size: 10.5px; font-weight: 600; background: var(--well); color: var(--ink2); }
.b-tabs button.ok .b-tm { background: var(--done-soft); color: var(--done); }
.b-tabs button.on .b-tm { background: var(--accent); color: var(--paper); }
.b-tabs::-webkit-scrollbar { display: none; }
.b-review { margin-left: auto; color: var(--dim) !important; }
.b-single { display: flex; align-items: center; gap: 8px; padding: 11px 16px; border-bottom: 1px solid var(--line); font-size: 13px; color: var(--ink2); }
.b-qm { width: 18px; height: 18px; border-radius: 50%; background: var(--accent); color: var(--paper); display: grid; place-items: center; font-size: 11px; font-weight: 700; }
.b-body { padding: 16px 16px 14px; display: flex; flex-direction: column; gap: 12px; }
.b-text { font-size: 16px; font-weight: 500; line-height: 1.45; }
.b-hint { font-size: 12px; color: var(--dim); margin-top: -6px; }
.b-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.b-grid .b-other { grid-column: 1 / -1; }
.b-list { display: flex; flex-direction: column; gap: 8px; }
.b-tile { display: flex; align-items: flex-start; gap: 10px; text-align: left; background: var(--paper); border: 1px solid var(--line2); border-radius: 10px; padding: 10px 12px; color: var(--ink); cursor: pointer; min-width: 0; }
.b-tile:hover { border-color: var(--dim); }
.b-tile.on { border-color: var(--accent); background: color-mix(in srgb, var(--accent-soft) 75%, var(--paper)); }
.b-num { flex-shrink: 0; width: 20px; height: 20px; border-radius: 6px; border: 1px solid var(--line2); display: grid; place-items: center; font-family: var(--mono); font-size: 11px; color: var(--dim); }
.b-tile.on .b-num { background: var(--accent); border-color: var(--accent); color: var(--paper); }
.b-tt { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.b-tl { font-size: 14px; font-weight: 500; }
.b-td { font-size: 12.5px; color: var(--dim); line-height: 1.4; }
.b-other { align-items: center; cursor: text; }
.b-other.focus { box-shadow: 0 0 0 3px var(--accent-soft); }
.b-in { font-size: 14px; }
.b-in.ph { color: var(--dim); }
.b-split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr); gap: 12px; }
.b-pane { background: var(--term); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; display: flex; flex-direction: column; }
.b-pane-h { font-size: 11px; color: var(--dim); padding: 7px 11px; border-bottom: 1px solid var(--line); letter-spacing: 0.03em; }
.b-pane pre { padding: 10px 12px; font-family: var(--mono); font-size: 12px; line-height: 1.6; color: var(--ink2); white-space: pre-wrap; }
.b-foot { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--line); background: color-mix(in srgb, var(--paper) 40%, var(--sheet)); flex-wrap: wrap; }
.b-add { background: none; border: 0; color: var(--dim); font-size: 12.5px; cursor: pointer; padding: 4px; }
.b-ghost { background: none; border: 1px solid var(--line2); color: var(--ink2); border-radius: 8px; padding: 5px 11px; font-size: 12.5px; cursor: pointer; }
.b-go { background: var(--accent); color: var(--paper); border: 0; border-radius: 8px; padding: 6px 14px; font-size: 13px; font-weight: 600; cursor: pointer; }
.b-go kbd { margin-left: 3px; }
.b-go.off { background: var(--well); color: var(--dim); }
.b-done { box-shadow: none; background: transparent; border-color: var(--line); }
.b-done-head { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-bottom: 1px solid var(--line); }
.b-chip { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; border-radius: 999px; padding: 2px 9px; }
.b-chip.done { background: var(--done-soft); color: var(--done); }
.b-sub { font-size: 12px; color: var(--dim); }
.b-table { border-collapse: collapse; width: 100%; font-size: 13px; }
.b-table th { text-align: left; font-weight: 400; color: var(--dim); padding: 7px 12px; width: 110px; vertical-align: top; font-size: 12.5px; }
.b-table td { padding: 5px 12px 5px 0; }
.b-ans { display: inline-block; background: var(--well); border-radius: 6px; padding: 1px 8px; margin: 2px 5px 2px 0; }

/* ---- C · Conversation ---- */
.c-flow { display: flex; flex-direction: column; gap: 12px; }
.c-q { display: flex; flex-direction: column; gap: 4px; }
.c-tag { align-self: flex-start; font-size: 11.5px; color: var(--accent-ink); background: var(--accent-soft); border-radius: 999px; padding: 1px 9px; }
.c-text { font-size: 15px; line-height: 1.6; color: var(--ink); }
.c-me { align-self: flex-end; display: flex; flex-direction: column; align-items: flex-end; gap: 3px; max-width: 86%; }
.c-bubble { background: var(--well); border: 1px solid var(--line2); border-radius: 15px 15px 4px 15px; padding: 7px 13px; font-size: 14px; line-height: 1.5; }
.c-at { font-size: 11px; color: var(--dim); }
.c-reply { display: flex; flex-direction: column; gap: 9px; padding: 12px; border: 1px dashed color-mix(in srgb, var(--accent) 55%, transparent); border-radius: 14px; background: color-mix(in srgb, var(--accent-soft) 30%, transparent); }
.c-chips { display: flex; flex-wrap: wrap; gap: 7px; }
.c-chip { display: inline-flex; align-items: center; gap: 7px; background: var(--sheet); border: 1px solid var(--line2); color: var(--ink); border-radius: 999px; padding: 6px 14px; font-size: 13.5px; cursor: pointer; }
.c-chip:hover { border-color: var(--dim); }
.c-chip.on { background: var(--accent); border-color: var(--accent); color: var(--paper); font-weight: 500; }
.c-chip.c-typing { background: var(--paper); color: var(--ink); border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); font-weight: 400; cursor: text; }
.c-chip.c-typing .c-box { background: var(--accent); color: var(--paper); border-color: var(--accent); }
.c-ol { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.05em; }
.c-otherb { color: var(--dim); border-style: dashed; }
.c-box { width: 14px; height: 14px; border-radius: 4px; border: 1.5px solid currentColor; display: grid; place-items: center; box-sizing: border-box; }
.c-chip.on .c-box { border-color: var(--paper); }
.c-desc { font-size: 12.5px; color: var(--dim); line-height: 1.5; }
.c-desc b { color: var(--ink2); font-weight: 500; }
.c-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.c-go { background: var(--accent); color: var(--paper); border: 0; border-radius: 999px; padding: 6px 15px; font-size: 13px; font-weight: 600; cursor: pointer; }
.c-go.off { background: var(--well); color: var(--dim); }
.c-fine { font-size: 12px; color: var(--dim); }
.c-link { background: none; border: 0; color: var(--dim); font-size: 12.5px; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; padding: 0; }
.c-prev { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; background: var(--term); }
.c-prev-h { display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 10px; border-bottom: 1px solid var(--line); font-size: 12.5px; color: var(--ink2); }
.c-prev-h button { background: var(--well); border: 0; color: var(--ink); width: 24px; height: 24px; border-radius: 6px; cursor: pointer; font-size: 15px; }
.c-pg { font-size: 11.5px; color: var(--dim); font-family: var(--mono); }
.c-prev pre { padding: 10px 12px; font-family: var(--mono); font-size: 12px; line-height: 1.6; color: var(--ink2); white-space: pre-wrap; }
.c-past { gap: 8px; }
.c-done-head { display: flex; align-items: center; gap: 9px; font-size: 13px; color: var(--dim); }
.c-tick { width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; background: var(--done-soft); color: var(--done); }
.c-pair { display: flex; gap: 10px; align-items: baseline; }
.c-ph { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.06em; min-width: 76px; text-align: right; }

@media (max-width: 700px) {
  .pick-grid { grid-template-columns: 1fr; padding: 10px 0; gap: 18px; }
  .pick-grid h2 { padding: 0 14px; }
  .win { height: auto; min-height: 780px; border-radius: 0; border-left: 0; border-right: 0; }
  .side { display: none; }
  .t-col { padding: 14px 14px 10px; }
  .t-comp { padding: 6px 14px 12px; }
  .a-k { display: none; }
  .a-text { font-size: 17px; }
  .b-grid, .b-split { grid-template-columns: 1fr; }
  .b-pane { order: -1; }
  .b-tabs button { padding: 8px 7px 9px; }
  .b-tabs .b-review { display: none; }
  .b-foot .b-add { width: 100%; text-align: left; }
  .c-me { max-width: 92%; }
}
`;
const style = document.createElement("style");
style.textContent = css;
document.head.append(style);
render();
