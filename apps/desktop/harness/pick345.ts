// Item 345 — three whole looks of the Edit-with-a-prompt panel for his pick (see pick345.html).
// Static HTML in the app's real tokens; nothing is wired. Each look draws the same four states from the
// same data, so the looks differ only in design.
import "../src/app.css";

type State = "empty" | "running" | "answered" | "proposal";
type Turn = {
  ask: string;
  status: "applied" | "answered" | "running" | "undone";
  reply: string;
  edits?: number;
  added?: number;
  removed?: number;
  diff?: string[];
  at: string;
  undo?: boolean;
};

const q = new URLSearchParams(location.search);
const STATES: State[] = ["empty", "running", "answered", "proposal"];
let state: State = (STATES as string[]).includes(q.get("state") ?? "") ? (q.get("state") as State) : "answered";
const only = q.get("look");
if (q.get("palette")) document.documentElement.dataset.palette = q.get("palette")!;

const NEUTRAL: Turn = {
  ask: "we dropped the neutral folder; update everything that assumes it",
  status: "applied",
  reply:
    "Struck the line that sends new chats to the neutral folder and added that a chat now opens in the project it was started from.",
  edits: 2,
  added: 2,
  removed: 0,
  diff: [
    "- New chats open in the neutral folder.",
    "+ ~~New chats open in the neutral folder.~~ (2026-10-12)",
    "+ A chat opens in the project it was started from.",
  ],
  at: "2:41 PM",
};
const SUMMARY: Turn = {
  ask: "summarize what changed this week",
  status: "answered",
  reply:
    "Two changes: the neutral folder is gone (struck today), and times are written in 12-hour AM/PM (added Tuesday). Nothing else moved.",
  at: "2:44 PM",
};
const WEEKLY: Turn = {
  ask: "also drop the line about weekly reviews",
  status: "applied",
  reply: "Struck the weekly-review line.",
  edits: 1,
  added: 1,
  removed: 1,
  diff: ["- Review the backlog every Friday.", "+ ~~Review the backlog every Friday.~~ (2026-10-12)"],
  at: "2:46 PM",
  undo: true,
};
const RUNNING: Turn = {
  ask: "times are AM/PM now, everywhere",
  status: "running",
  reply: "Found three times written as 24-hour; changing them one at a time…",
  edits: 2,
  at: "2:49 PM",
};

function data(s: State): { turns: Turn[]; typed: string; proposal: boolean; running: boolean } {
  switch (s) {
    case "empty":
      return { turns: [], typed: "", proposal: false, running: false };
    case "running":
      return { turns: [{ ...NEUTRAL, undo: false }, RUNNING], typed: "", proposal: false, running: true };
    case "answered":
      return { turns: [{ ...NEUTRAL, undo: false }, SUMMARY, WEEKLY], typed: "", proposal: false, running: false };
    case "proposal":
      return { turns: [], typed: "we now use AM/PM times", proposal: true, running: false };
  }
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

// ---- Look A · Thread: a quiet chat; the composer is one card ---------------------------------------
function lookA(s: State): string {
  const d = data(s);
  const body =
    d.turns.length === 0
      ? `<div class="a-empty">
          <p class="a-lead">Say what changed, or ask about the note.</p>
          <div class="a-sugs">
            <button>We dropped the neutral folder — update what assumes it</button>
            <button>Summarize what changed</button>
            <button>Tighten the wording</button>
          </div>
          <p class="a-fine">It reads and edits this file only. Each request undoes in one step.</p>
        </div>`
      : d.turns
          .map(
            (t) => `<div class="a-turn">
          <div class="a-ask">${esc(t.ask)}</div>
          <div class="a-said">${esc(t.reply)}</div>
          ${
            t.status === "running"
              ? `<div class="a-meta live"><span class="dot"></span>Editing · ${plural(t.edits ?? 0, "edit")} so far</div>`
              : t.status === "answered"
                ? `<div class="a-meta">answered · no edit</div>`
                : `<div class="a-meta"><span class="pill"><b class="add">+${t.added}</b> <b class="del">−${t.removed}</b></span>saved · ${t.at}${
                    t.undo ? `<span class="sp"></span><button class="a-undo">Undo</button>` : ""
                  }</div>`
          }
        </div>`,
          )
          .join("");
  const notice = d.proposal
    ? `<div class="a-notice"><span class="dot copper"></span><span>A dream's proposal is open on this note — it stays pending.</span><button class="a-link">Show</button></div>`
    : "";
  const sendOn = !!d.typed.trim() && !d.running;
  return `<aside class="a-panel">
    <header class="a-head"><div><div class="a-title">Edit with a prompt</div><div class="a-file">MEMORY.md</div></div><span class="sp"></span><button class="a-x" aria-label="Close">×</button></header>
    <div class="a-list">${body}</div>
    <footer class="a-foot">
      ${notice}
      <div class="a-card">
        <textarea rows="2" placeholder="What changed? Or ask about the note" autocorrect="off" autocapitalize="off" spellcheck="false">${esc(d.typed)}</textarea>
        <div class="a-bar">
          <label class="a-sw"><span class="sw on"><i></i></span>Strike, don't delete</label>
          <span class="sp"></span>
          ${
            d.running
              ? `<button class="a-stop" aria-label="Stop"><i></i></button>`
              : `<button class="a-send${sendOn ? "" : " off"}" aria-label="Send">↑</button>`
          }
        </div>
      </div>
      <div class="a-model">opus</div>
    </footer>
  </aside>`;
}

// ---- Look B · Ledger: each exchange a card with its diff; Strike/Rewrite as a switch -----------------
function lookB(s: State): string {
  const d = data(s);
  const diff = (t: Turn) =>
    t.diff
      ? `<div class="b-diff">${t.diff
          .map((l) => `<div class="${l.startsWith("+") ? "add" : "del"}">${esc(l)}</div>`)
          .join("")}</div>`
      : "";
  const chip = (t: Turn) =>
    t.status === "running"
      ? `<span class="b-chip live"><span class="dot"></span>Editing · ${plural(t.edits ?? 0, "edit")}</span>`
      : t.status === "answered"
        ? `<span class="b-chip info">Answered</span>`
        : `<span class="b-chip done">Saved · +${t.added} −${t.removed}</span>`;
  const body =
    d.turns.length === 0
      ? `<ol class="b-how">
          <li><b>Say what changed.</b> "We dropped the neutral folder; update everything that assumes it."</li>
          <li><b>Watch it land.</b> The model edits this file; each edit shows in the note as it happens.</li>
          <li><b>Undo in one step.</b> Every request can be put back. Ask questions too — it answers without editing.</li>
        </ol>`
      : d.turns
          .map(
            (t) => `<article class="b-card${t.status === "running" ? " running" : ""}">
          <div class="b-ask">${esc(t.ask)}</div>
          <div class="b-said">${esc(t.reply)}</div>
          ${diff(t)}
          <div class="b-row">${chip(t)}<span class="sp"></span><span class="b-at">${t.at}</span>${
            t.undo ? `<button class="b-btn">Undo</button>` : ""
          }</div>
        </article>`,
          )
          .join("");
  const banner = d.proposal
    ? `<div class="b-banner"><div><b>Dream proposal pending.</b> Edits here land on the file; the proposal waits for you.</div><button class="b-btn">Show it</button></div>`
    : "";
  const sendOn = !!d.typed.trim() && !d.running;
  return `<aside class="b-panel">
    <header class="b-head"><span class="b-title">Edit with a prompt</span><span class="b-file">MEMORY.md</span><span class="sp"></span><button class="b-x" aria-label="Close">×</button></header>
    ${banner}
    <div class="b-list">${body}</div>
    <footer class="b-foot">
      <textarea rows="3" placeholder="What changed? Or ask about the note" autocorrect="off" autocapitalize="off" spellcheck="false">${esc(d.typed)}</textarea>
      <div class="b-bar">
        <div class="b-seg" role="group" aria-label="Old lines"><button class="on">Strike</button><button>Rewrite</button></div>
        <span class="sp"></span>
        ${
          d.running
            ? `<button class="b-send stop">Stop</button>`
            : `<button class="b-send${sendOn ? "" : " off"}">Send <kbd>↵</kbd></button>`
        }
      </div>
      <div class="b-model">opus · this file only</div>
    </footer>
  </aside>`;
}

// ---- Look C · Command: the box on top, a timeline under it, newest first --------------------------
function lookC(s: State): string {
  const d = data(s);
  const turns = [...d.turns].reverse();
  const body =
    turns.length === 0
      ? `<div class="c-try"><div class="c-label">Try</div>
          <button><span>We dropped the neutral folder — update what assumes it</span><kbd>↵</kbd></button>
          <button><span>Summarize what changed this week</span><kbd>↵</kbd></button>
          <button><span>Make the rules shorter, keep the meaning</span><kbd>↵</kbd></button>
          <p class="c-fine">Edits this file only, each one shown as it lands. Any request undoes in one step.</p>
        </div>`
      : `<ol class="c-line">${turns
          .map(
            (t) => `<li class="c-${t.status}">
            <span class="c-dot"></span>
            <div class="c-ask">${esc(t.ask)}</div>
            <div class="c-said">${esc(t.reply)}</div>
            <div class="c-meta">${
              t.status === "running"
                ? `<span class="live">editing · ${plural(t.edits ?? 0, "edit")} so far</span>`
                : t.status === "answered"
                  ? `answered · ${t.at}`
                  : `<b class="add">+${t.added}</b> <b class="del">−${t.removed}</b> · saved · ${t.at}`
            }${t.undo ? ` · <button class="c-link">Undo</button>` : ""}</div>
          </li>`,
          )
          .join("")}</ol>`;
  const sendOn = !!d.typed.trim() && !d.running;
  return `<aside class="c-panel">
    <header class="c-head"><span class="c-title">Edit with a prompt</span><span class="sp"></span><button class="c-x" aria-label="Close">×</button></header>
    <div class="c-box">
      <div class="c-input">
        <textarea rows="2" placeholder="What changed? Or ask about the note" autocorrect="off" autocapitalize="off" spellcheck="false">${esc(d.typed)}</textarea>
        ${
          d.running
            ? `<button class="c-go stop" aria-label="Stop"><i></i></button>`
            : `<button class="c-go${sendOn ? "" : " off"}" aria-label="Send">↵</button>`
        }
      </div>
      <div class="c-opts"><span class="c-tag on">✓ strike, don't delete</span><span class="c-tag">opus</span><span class="c-tag">MEMORY.md only</span></div>
      ${
        d.proposal
          ? `<div class="c-prop"><span class="dot copper"></span>Dream proposal pending — edits land on the file, it waits. <button class="c-link">Show</button></div>`
          : ""
      }
    </div>
    <div class="c-list">${body}</div>
  </aside>`;
}

const LOOKS: [string, string, string, (s: State) => string][] = [
  ["A", "Thread", "a quiet chat; one composer card with a round Send", lookA],
  ["B", "Ledger", "each request a card with its diff; Strike/Rewrite switch", lookB],
  ["C", "Command", "the box on top, a timeline under it, newest first", lookC],
];

// A strip of the note beside the panel, so each look is seen in place.
function notePane(s: State): string {
  const lines = [
    "# Memory",
    "",
    "- Times in 12-hour AM/PM.",
    "- New chats open in the neutral folder.",
    "- Review the backlog every Friday.",
    "- Plans before code.",
    "- Push without asking.",
  ];
  if (s === "proposal")
    return `<div class="note"><div class="note-prop"><span class="lbl">why</span> Three chats asked for AM/PM times.<div class="note-btns"><i>Accept</i><i>Open</i><i>Dismiss</i></div></div>${lines
      .map((l) => `<div class="nl">${esc(l) || "&nbsp;"}</div>`)
      .join("")}</div>`;
  return `<div class="note">${lines
    .map(
      (l, i) =>
        `<div class="nl${s === "running" && i === 2 ? " mark" : ""}">${esc(l) || "&nbsp;"}</div>`,
    )
    .join("")}</div>`;
}

function render() {
  const root = document.getElementById("root")!;
  root.innerHTML = `<header class="pick-head">
      <h1>Pick a panel — reply with a letter</h1>
      <nav>${STATES.map((s) => `<button data-s="${s}" class="${s === state ? "on" : ""}">${s === "proposal" ? "proposal open" : s}</button>`).join("")}</nav>
    </header>
    <main class="pick-grid">${LOOKS.filter(([l]) => !only || l === only)
      .map(
        ([l, name, what, f]) => `<section>
        <h2>${l} · ${name} <span>— ${what}</span></h2>
        <div class="win">${notePane(state)}${f(state)}</div>
      </section>`,
      )
      .join("")}</main>`;
  for (const b of root.querySelectorAll<HTMLButtonElement>("nav button"))
    b.onclick = () => {
      state = b.dataset.s as State;
      render();
    };
}

const css = `
html, body { overflow: auto; height: auto; min-height: 100%; }
body { font-family: var(--sans); }
.sp { flex: 1; }
.dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--live); flex-shrink: 0; }
.dot.copper { background: var(--accent); }
.add { color: var(--add-fg); font-weight: 500; }
.del { color: var(--del-fg); font-weight: 500; }
button { font-family: inherit; }
kbd { font-family: var(--mono); font-size: 0.68rem; opacity: 0.8; }

.pick-head { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--line); }
.pick-head h1 { font-size: 15px; margin: 0; font-weight: 600; }
.pick-head nav { display: flex; gap: 6px; flex-wrap: wrap; }
.pick-head nav button { font-size: 12.5px; padding: 4px 11px; border-radius: 999px; border: 1px solid var(--line2); background: transparent; color: var(--ink2); cursor: pointer; }
.pick-head nav button.on { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-ink); }
.pick-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; padding: 10px; }
.pick-grid section { display: flex; flex-direction: column; min-width: 0; }
.pick-grid h2 { margin: 0 0 6px; font-size: 13.5px; font-weight: 600; }
.pick-grid h2 span { font-weight: 400; color: var(--dim); }
.win { display: flex; height: calc(100vh - 112px); min-height: 640px; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: var(--paper); }
.note { flex: 1; min-width: 0; padding: 14px 12px; font-family: var(--mono); font-size: 11.5px; color: var(--ink2); overflow: hidden; }
.nl { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.7; }
.nl.mark { background: var(--add-bg); color: var(--add-fg); }
.note-prop { border: 1px solid var(--accent); border-radius: 6px; padding: 8px; margin-bottom: 10px; font-family: var(--sans); font-size: 11px; color: var(--ink2); }
.note-prop .lbl { text-transform: uppercase; font-size: 9.5px; color: var(--dim); letter-spacing: 0.06em; }
.note-btns { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
.note-btns i { font-style: normal; border: 1px solid var(--line2); border-radius: 5px; padding: 1px 6px; }
aside { width: 340px; flex-shrink: 0; display: flex; flex-direction: column; min-height: 0; border-left: 1px solid var(--line); background: var(--sheet); color: var(--ink); }
textarea { font-family: inherit; color: var(--ink); resize: none; }
textarea:focus { outline: none; }
textarea::placeholder { color: var(--dim); }

/* ---- A · Thread ---- */
.a-head { display: flex; align-items: center; padding: 12px 14px 10px; }
.a-title { font-size: 13.5px; font-weight: 600; color: var(--ink); }
.a-file { font-family: var(--mono); font-size: 11px; color: var(--dim); margin-top: 1px; }
.a-x { background: none; border: 0; color: var(--dim); font-size: 18px; cursor: pointer; border-radius: 6px; width: 26px; height: 26px; }
.a-x:hover { background: var(--well); color: var(--ink); }
.a-list { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 14px 12px; display: flex; flex-direction: column; gap: 16px; }
.a-empty { margin-top: auto; display: flex; flex-direction: column; gap: 10px; }
.a-lead { margin: 0; font-family: var(--serif); font-size: 17px; color: var(--ink); }
.a-sugs { display: flex; flex-direction: column; gap: 6px; }
.a-sugs button { text-align: left; background: var(--well); border: 1px solid var(--line); color: var(--ink2); border-radius: 9px; padding: 7px 10px; font-size: 12.5px; cursor: pointer; }
.a-sugs button:hover { border-color: var(--line2); color: var(--ink); }
.a-fine { margin: 2px 0 0; font-size: 11.5px; color: var(--dim); line-height: 1.45; }
.a-turn { display: flex; flex-direction: column; gap: 6px; }
.a-ask { align-self: flex-end; max-width: 86%; background: var(--well); border: 1px solid var(--line2); border-radius: 14px 14px 4px 14px; padding: 6px 11px; font-size: 13px; line-height: 1.45; }
.a-said { font-size: 13px; line-height: 1.55; color: var(--ink); }
.a-meta { display: flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--dim); }
.a-meta.live { color: var(--live); }
.a-meta .pill { background: var(--well); border-radius: 999px; padding: 0 7px; font-family: var(--mono); font-size: 11px; }
.a-undo { background: none; border: 1px solid var(--line2); border-radius: 7px; color: var(--ink2); font-size: 11.5px; padding: 2px 9px; cursor: pointer; }
.a-foot { padding: 8px 12px 10px; display: flex; flex-direction: column; gap: 6px; }
.a-notice { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--ink2); background: var(--accent-soft); border-radius: 8px; padding: 6px 9px; line-height: 1.35; }
.a-link { background: none; border: 0; color: var(--accent-ink); font-size: 11.5px; cursor: pointer; padding: 0; text-decoration: underline; }
.a-card { background: var(--well); border: 1px solid var(--line2); border-radius: 12px; padding: 8px 8px 6px 11px; display: flex; flex-direction: column; gap: 4px; }
.a-card:focus-within { border-color: var(--accent); }
.a-card textarea { background: transparent; border: 0; padding: 0; font-size: 13.5px; line-height: 1.5; }
.a-bar { display: flex; align-items: center; gap: 8px; }
.a-sw { display: flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--dim); cursor: pointer; }
.sw { width: 24px; height: 14px; border-radius: 999px; background: var(--line2); position: relative; }
.sw i { position: absolute; top: 2px; left: 2px; width: 10px; height: 10px; border-radius: 50%; background: var(--ink2); }
.sw.on { background: var(--accent); }
.sw.on i { left: 12px; background: var(--paper); }
.a-send { width: 30px; height: 30px; border-radius: 50%; border: 0; background: var(--accent); color: var(--paper); font-size: 16px; font-weight: 700; cursor: pointer; }
.a-send.off { background: var(--line2); color: var(--dim); cursor: default; }
.a-stop { width: 30px; height: 30px; border-radius: 50%; border: 1px solid var(--line2); background: var(--sheet); cursor: pointer; display: grid; place-items: center; }
.a-stop i { width: 10px; height: 10px; border-radius: 2px; background: var(--ink); }
.a-model { font-size: 10.5px; color: var(--dim); padding-left: 4px; }

/* ---- B · Ledger ---- */
.b-head { display: flex; align-items: baseline; gap: 8px; padding: 11px 14px; border-bottom: 1px solid var(--line); }
.b-title { font-size: 13px; font-weight: 600; }
.b-file { font-family: var(--mono); font-size: 11px; color: var(--dim); }
.b-x { background: none; border: 0; color: var(--dim); font-size: 17px; cursor: pointer; }
.b-banner { display: flex; gap: 10px; align-items: center; padding: 9px 14px; background: var(--accent-soft); border-bottom: 1px solid var(--accent); font-size: 12px; line-height: 1.4; color: var(--ink2); }
.b-banner b { color: var(--accent-ink); font-weight: 600; }
.b-list { flex: 1; min-height: 0; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.b-how { margin: 0; padding: 4px 4px 0 22px; display: flex; flex-direction: column; gap: 12px; font-size: 12.5px; line-height: 1.5; color: var(--ink2); }
.b-how b { color: var(--ink); font-weight: 600; }
.b-how li::marker { color: var(--accent); font-weight: 700; }
.b-card { background: var(--paper); border: 1px solid var(--line); border-radius: 10px; padding: 10px 11px; display: flex; flex-direction: column; gap: 6px; }
.b-card.running { border-color: var(--live); }
.b-ask { font-size: 13px; font-weight: 600; line-height: 1.4; }
.b-said { font-size: 12.5px; line-height: 1.5; color: var(--ink2); }
.b-diff { font-family: var(--mono); font-size: 10.5px; line-height: 1.6; border-radius: 6px; overflow: hidden; }
.b-diff div { padding: 0 7px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.b-diff .add { background: var(--add-bg); color: var(--add-fg); font-weight: 400; }
.b-diff .del { background: var(--del-bg); color: var(--del-fg); font-weight: 400; }
.b-row { display: flex; align-items: center; gap: 8px; margin-top: 2px; }
.b-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; border-radius: 999px; padding: 1px 9px; }
.b-chip.done { background: var(--done-soft); color: var(--done); }
.b-chip.info { background: var(--live-soft); color: var(--live); }
.b-chip.live { background: var(--live-soft); color: var(--live); }
.b-at { font-size: 11px; color: var(--dim); }
.b-btn { background: var(--well); border: 1px solid var(--line2); color: var(--ink); border-radius: 7px; font-size: 11.5px; padding: 3px 10px; cursor: pointer; white-space: nowrap; }
.b-foot { border-top: 1px solid var(--line); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.b-foot textarea { background: var(--paper); border: 1px solid var(--line2); border-radius: 8px; padding: 8px 10px; font-size: 13px; line-height: 1.5; }
.b-foot textarea:focus { border-color: var(--accent); }
.b-bar { display: flex; align-items: center; gap: 8px; }
.b-seg { display: inline-flex; background: var(--paper); border: 1px solid var(--line2); border-radius: 8px; padding: 2px; }
.b-seg button { background: none; border: 0; color: var(--dim); font-size: 11.5px; padding: 3px 10px; border-radius: 6px; cursor: pointer; }
.b-seg button.on { background: var(--well); color: var(--ink); }
.b-send { background: var(--accent); color: var(--paper); border: 0; border-radius: 8px; font-size: 12.5px; font-weight: 600; padding: 6px 14px; cursor: pointer; }
.b-send kbd { margin-left: 4px; }
.b-send.off { background: var(--well); color: var(--dim); cursor: default; }
.b-send.stop { background: var(--well); color: var(--ink); border: 1px solid var(--line2); }
.b-model { font-size: 10.5px; color: var(--dim); }

/* ---- C · Command ---- */
.c-head { display: flex; align-items: center; padding: 10px 14px 6px; }
.c-title { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--dim); font-weight: 600; }
.c-x { background: none; border: 0; color: var(--dim); font-size: 17px; cursor: pointer; }
.c-box { padding: 0 12px 12px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
.c-input { display: flex; align-items: flex-end; gap: 6px; background: var(--paper); border: 1px solid var(--line2); border-radius: 10px; padding: 8px 6px 6px 11px; }
.c-input:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.c-input textarea { flex: 1; background: transparent; border: 0; padding: 0; font-size: 14px; line-height: 1.5; }
.c-go { width: 28px; height: 28px; border-radius: 7px; border: 0; background: var(--accent); color: var(--paper); font-size: 14px; font-weight: 700; cursor: pointer; flex-shrink: 0; display: grid; place-items: center; }
.c-go.off { background: var(--well); color: var(--dim); cursor: default; }
.c-go.stop { background: var(--well); border: 1px solid var(--line2); }
.c-go.stop i { width: 9px; height: 9px; border-radius: 2px; background: var(--ink); }
.c-opts { display: flex; gap: 6px; flex-wrap: wrap; }
.c-tag { font-size: 11px; color: var(--dim); border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; }
.c-tag.on { color: var(--accent-ink); border-color: var(--accent); }
.c-prop { display: flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--ink2); line-height: 1.35; }
.c-link { background: none; border: 0; padding: 0; color: var(--accent-ink); font-size: inherit; text-decoration: underline; cursor: pointer; }
.c-list { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 14px 12px; }
.c-try { display: flex; flex-direction: column; gap: 4px; }
.c-label { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 2px; }
.c-try button { display: flex; align-items: center; gap: 8px; text-align: left; background: none; border: 0; border-radius: 7px; padding: 7px 8px; color: var(--ink2); font-size: 12.5px; cursor: pointer; }
.c-try button span { flex: 1; }
.c-try button:hover { background: var(--well); color: var(--ink); }
.c-fine { margin: 10px 8px 0; font-size: 11.5px; color: var(--dim); line-height: 1.45; }
.c-line { list-style: none; margin: 0; padding: 0 0 0 16px; border-left: 1px solid var(--line2); display: flex; flex-direction: column; gap: 16px; margin-left: 4px; }
.c-line li { position: relative; display: flex; flex-direction: column; gap: 3px; }
.c-dot { position: absolute; left: -21px; top: 5px; width: 9px; height: 9px; border-radius: 50%; background: var(--done); border: 2px solid var(--sheet); }
.c-running .c-dot { background: var(--live); box-shadow: 0 0 0 3px var(--live-soft); }
.c-answered .c-dot { background: var(--sheet); border-color: var(--live); }
.c-undone .c-dot { background: var(--dim); }
.c-ask { font-size: 13px; font-weight: 600; line-height: 1.4; }
.c-said { font-size: 12.5px; line-height: 1.5; color: var(--ink2); }
.c-meta { font-size: 11px; color: var(--dim); font-family: var(--mono); }
.c-meta .live { color: var(--live); }

@media (max-width: 700px) {
  .pick-grid { grid-template-columns: 1fr; padding: 10px 0; gap: 18px; }
  .pick-grid h2 { padding: 0 16px; }
  .win { height: 700px; min-height: 0; border-radius: 0; border-left: 0; border-right: 0; }
  .note { display: none; }
  aside { width: 100%; border-left: 0; }
}
`;
const style = document.createElement("style");
style.textContent = css;
document.head.append(style);
render();
