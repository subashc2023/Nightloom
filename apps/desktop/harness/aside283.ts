// Backlog 283 harness — see aside283.html.
import "../src/app.css";
import "katex/dist/katex.min.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import { mount, flushSync } from "svelte";
import AsideCard from "../src/lib/AsideCard.svelte";
import AsideView from "../src/lib/AsideView.svelte";
import { app, draftAside, switchAside } from "../src/lib/state.svelte";
import { addAttachment } from "../src/lib/drafts.svelte";
import { asideDraftKey } from "../src/lib/asides";
import { composerFormat } from "../src/lib/composerFormat.svelte";

// The Tauri bridge, faked: nothing answers.
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async () => null,
  transformCallback: () => 0,
};

const q = new URLSearchParams(location.search);
const v = q.get("v") ?? "card";
document.documentElement.dataset.palette = q.get("p") ?? "A";
composerFormat.on = q.get("format") !== "0";
const root = document.getElementById("root")!;
const cap = document.getElementById("cap")!;

app.sessions = [
  { id: "chat-a", title: "Stuart 9 deep thoughts" },
  { id: "chat-b", title: "Another chat" },
] as unknown as typeof app.sessions;
app.connection = { engine: "claude-code", workspace: "/tmp" } as unknown as typeof app.connection;
app.activeSessionId = "chat-a";
app.draft.engine = "claude-code";
app.draft.agentModel = "opus";
app.draft.agentEffort = "high";

const PNG =
  "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";
const a = draftAside({ text: "The watermark advances only on success, so a failed unit is redone rather than skipped.", role: "assistant", ordinal: 2 }, null)!;
a.name = "Watermark and redo cost";
const long = [
  "Put as an expected cost, with $p$ the chance a unit fails and $c$ its cost:",
  "$$E[\\text{redo}] = p \\cdot c \\qquad E[\\text{skip}] = p \\cdot \\sum_{k \\ge 1} c_k$$",
  "The watermark is the runner's promise that **every unit it skips really happened**. Advancing it on failure would turn a crash into silent data loss: the next run reads the watermark, believes the unit is done, and never looks at it again.",
  "Redoing is cheap by comparison. A unit is small by design, so the cost of a redo is bounded by one unit's work, while the cost of a skip is unbounded — it is everything downstream that trusted the result.",
  "so the redo is always the cheaper side once anything depends on the unit ($\\sum_k c_k \\ge c$).",
  "Two consequences follow. First, units must be idempotent — writing the same file twice must leave the same file. Second, the commit message is written by the unit but the commit is made by the runner, so a unit that dies mid-write leaves a WIP commit and the watermark where it was.",
  "- the runner owns `state/watermark.json`\n- a unit's edit to it is reverted\n- `UNIT_FAILED` keeps the watermark",
].join("\n\n");
if (q.get("draft") !== "1") {
  a.draft = false;
  const asking = q.get("asking") === "1";
  a.turns.push({
    seq: 1,
    question: "Why does the watermark only advance on success? Here is the runner's log from last night.",
    partial: long,
    answer: long,
    error: null,
    cancelled: false,
    cacheRead: 41_230,
    attachments: [
      { id: 1, kind: "image", name: "runner.png", media_type: "image/png", data: PNG },
      { id: 2, kind: "document", name: "Pasted text", media_type: "text/plain", data: btoa("unit 12 failed: rate limit\nunit 12 redone: ok\n"), pasted: true, label: "2 lines" },
    ],
    model: "claude-opus-5",
    usage: { input_tokens: 48_000, output_tokens: 412, cache_read_tokens: 41_230 },
    at: new Date(Date.now() - 4 * 60_000).toISOString(),
  });
  a.turns.push({
    seq: 2,
    question: "> a failed unit is redone rather than skipped\nAnd what if the redo fails the same way?",
    partial: asking ? "It is retried on the next run, and the blocker" : "It fails again and stays where it is: the watermark does not move, the next run tries again, and after the retry cap the unit is written up as a blocker instead of being retried forever.",
    answer: asking ? null : "It fails again and stays where it is: the watermark does not move, the next run tries again, and after the retry cap the unit is written up as a blocker instead of being retried forever.",
    error: null,
    cancelled: false,
    cacheRead: 41_230,
    model: asking ? undefined : "claude-opus-5",
    usage: asking ? undefined : { input_tokens: 49_000, output_tokens: 61 },
    at: asking ? undefined : new Date().toISOString(),
  });
}
const key = asideDraftKey(a);
a.unsent = "Would the same hold for the dream's own watermark? $\\Delta t$ matters there";
addAttachment(key, { id: 7, kind: "document", name: "dream-log.md", media_type: "text/plain", data: btoa("dream log\n"), label: "text" });
if (q.get("open") === "0") {
  switchAside("chat-b");
  app.activeSessionId = "chat-b";
}

if (v === "tab") {
  root.style.flexDirection = "column";
  mount(AsideView, { target: root, props: { session: "chat-a", thread: a.id } });
} else if (v === "panel") {
  // The chat's column on the left (a stand-in), the side panel on the right.
  root.innerHTML = `<div style="flex:1;padding:24px;color:var(--ink2);font:14px/1.6 var(--sans)">
    <p>The chat's transcript sits here, untinted — the side panel at the window's right edge is the aside.</p></div>
    <div id="panel" style="width:430px;display:flex;flex-direction:column;border-left:1px solid var(--line);"></div>`;
  mount(AsideCard, { target: document.getElementById("panel")!, props: { aside: a, placement: null, panel: true, session: "chat-a" } });
} else {
  // The floating card under its passage, over a stand-in transcript.
  root.innerHTML = `<div id="col" style="position:relative;flex:1;padding:24px 60px;overflow:hidden;color:var(--ink);font:15px/1.6 var(--sans)">
    <p style="max-width:760px">${"The runner commits on the unit's behalf and only then advances the watermark. ".repeat(3)}<mark style="background:var(--accent-soft);color:inherit">The watermark advances only on success, so a failed unit is redone rather than skipped.</mark> ${"Redoing is cheap; skipping is not. ".repeat(4)}</p></div>`;
  const col = document.getElementById("col")!;
  mount(AsideCard, {
    target: col,
    props: { aside: a, placement: { top: 150, left: 120, width: 520, maxHeight: 430, side: "below" } },
  });
}
flushSync();
// &at=math: the thread scrolled so the first reply's display math is in view.
if (q.get("at") === "math")
  setTimeout(() => {
    const m = document.querySelector<HTMLElement>(".aside-thread .user-bubble");
    m?.scrollIntoView({ block: "start" });
  }, 250);
setTimeout(() => {
  const r = (sel: string) => {
    const e = document.querySelector(sel);
    if (!e) return "absent";
    const b = e.getBoundingClientRect();
    return `${Math.round(b.top)}..${Math.round(b.bottom)}`;
  };
  cap.textContent = `${v} p=${document.documentElement.dataset.palette} · composer ${r(".composer")} · row ${r(".composer .row")} · thread ${r(".aside-thread")} · root ..${Math.round(root.getBoundingClientRect().bottom)}`;
}, 400);
