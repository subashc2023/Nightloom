// Item 674 harness — see aside674.html.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import { mount, flushSync, tick } from "svelte";
import AsideView from "../src/lib/AsideView.svelte";
import AsideCard from "../src/lib/AsideCard.svelte";
import Transcript from "../src/lib/Transcript.svelte";
import { app, asideTurnEvent, draftAside, runToastAction, settleAsideSegments, type Aside, type Segment } from "../src/lib/state.svelte";
import { readDraft } from "../src/lib/drafts.svelte";
import { asideDraftKey } from "../src/lib/asides";
import { applyLayout, layout } from "../src/lib/layout.svelte";
import type { SessionEvent } from "../src/lib/types";

const q = new URLSearchParams(location.search);
const n = Number(q.get("turns") ?? "4");
const v = q.get("v") ?? "tab";
const act = q.get("do") ?? "";
const root = document.getElementById("root")!;
const cap = document.getElementById("cap")!;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The Tauri bridge, faked. `ask_aside` waits until the script answers it,
// so an exchange can be held asking, streamed into, settled.
const asks: { seq: number; text: string; done: (r: unknown) => void }[] = [];
const cancelled: number[] = [];
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "ask_aside") return new Promise((done) => asks.push({ seq: args.seq as number, text: args.text as string, done }));
    if (cmd === "cancel_aside") cancelled.push(args.seq as number);
    return Promise.resolve(cmd === "turn_usage" ? [] : null);
  },
  transformCallback: () => 0,
};

app.sessions = [{ id: "chat-a", title: "Midterm prep" }] as unknown as typeof app.sessions;
app.connection = { engine: "claude-code", model: "claude-opus-5-5", contextLimit: 1_000_000 } as unknown as typeof app.connection;
app.activeSessionId = "chat-a";
// A project, so Fold into thread is offered (its own condition).
if (q.get("project") !== "0") app.project = { id: "p1", name: "Nightshift", path: "/tmp/p1" } as unknown as typeof app.project;
if (q.get("classic") === "1") {
  layout.value = "classic";
  applyLayout("classic");
}

const para =
  "The watermark advances only on success, so a unit that fails is redone rather than skipped; redoing is cheap and skipping is not. ";
// A composer aside (no passage): in the chat view its card sits above the composer.
const a: Aside = draftAside({ text: "The watermark advances only on success.", role: "assistant", ordinal: 2 }, null)!;
a.draft = false;
const first = q.get("long") === "1"
  ? "Why is the stack built on one queue instead of two, and what would break in the amortised analysis if the transfer happened on every push rather than only when the output side runs dry?"
  : "Stack on one queue";
for (let i = 0; i < n; i++) {
  const asking = q.get("asking") === "1" && i === n - 1;
  const stopped = q.get("stopped") === "1" && i === n - 1;
  const ans = Array.from({ length: 3 }, (_, k) => `Paragraph ${k + 1} of answer ${i + 1}. ${para.repeat(2)}`).join("\n\n");
  const segments: Segment[] = [
    { kind: "thinking", text: `Thinking about question ${i + 1}: the unit either lands or it does not.`, done: !asking },
    { kind: "tool", call: { id: `t${i}`, name: "Read", input: { file_path: "state/watermark.json" }, result: { content: '{"unit": 41}', is_error: false } } },
    { kind: "text", text: asking ? ans.slice(0, 220) : stopped ? ans.slice(0, 300) : ans },
  ];
  a.turns.push({
    seq: 1000 + i,
    question: i === 0 ? first : `Question ${i + 1}: why does it advance only on success?`,
    partial: asking ? ans.slice(0, 220) : ans,
    answer: asking || stopped ? null : ans,
    error: q.get("stopped") === "1" && i === n - 2 ? "The answer could not be read back." : null,
    cancelled: stopped,
    cacheRead: 188_342,
    model: "claude-opus-5-5",
    usage: asking ? undefined : { input_tokens: 190_000 + i * 900, output_tokens: 640, cache_read_tokens: 188_342 },
    at: asking ? undefined : new Date(Date.now() - (n - i) * 60_000).toISOString(),
    tookMs: 9_000,
    startedAt: asking ? Date.now() - 12_000 : undefined,
    heardAt: asking ? Date.now() - 1_000 : undefined,
    phase: asking ? "running" : undefined,
    segments,
  });
}

if (v === "tab") {
  mount(AsideView, { target: root, props: { session: "chat-a", thread: a.id } });
} else if (v === "panel") {
  root.style.flexDirection = "row";
  root.innerHTML = `<div style="flex:1;padding:24px;color:var(--ink2);font:14px/1.6 var(--sans)">The chat's transcript sits here.</div>
    <div id="panel" style="width:430px;display:flex;flex-direction:column;min-height:0;border-left:1px solid var(--line);"></div>`;
  mount(AsideCard, { target: document.getElementById("panel")!, props: { aside: a, placement: null, panel: true, session: "chat-a" } });
} else if (v === "card") {
  root.innerHTML = `<div id="col" style="position:relative;flex:1;padding:24px 60px;overflow:hidden;color:var(--ink);font:15px/1.6 var(--sans)">
    <p style="max-width:760px">${"The runner commits on the unit's behalf and only then advances the watermark. ".repeat(3)}</p></div>`;
  mount(AsideCard, {
    target: document.getElementById("col")!,
    props: { aside: a, placement: { top: 110, left: 120, width: 560, maxHeight: Number(q.get("room") ?? 560), side: "below" } },
  });
} else {
  // The chat's own Transcript with the aside's card inside it.
  const at = new Date(Date.now() - 50 * 60_000).toISOString();
  const evs: SessionEvent[] = [];
  for (let i = 0; i < 4; i++) {
    evs.push({ event: "user_message", text: `Chat question ${i + 1}: what does the runner do on a failed unit?`, at });
    evs.push({
      event: "assistant_message",
      model: "claude-opus-5-5",
      blocks: [{ type: "text", text: `Chat answer ${i + 1}. ${para.repeat(3)}` }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 10 },
      at,
    } as SessionEvent);
  }
  app.events = evs;
  root.innerHTML = `<div id="content" style="position:relative;flex:1;min-height:0;display:flex;flex-direction:column"></div>`;
  mount(Transcript, { target: document.getElementById("content")!, props: {} });
}
flushSync();

// ---- The driver: one scripted run per `do`, its result said in the caption ----
const $ = <T extends HTMLElement = HTMLElement>(sel: string, from: ParentNode = document) => from.querySelector<T>(sel);
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, from: ParentNode = document) => [...from.querySelectorAll<T>(sel)];
/** The aside's transcript: the only one in a tab, card or panel; in the chat view the one inside the card. */
const asideT = () => (v === "chat" ? $(".aside-card .transcript") : $(".transcript"));
const userTurns = (t: HTMLElement) => $$(".user-turn", t);
const press = (el: Element | null | undefined) => (el as HTMLElement | null)?.click();
const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
const type = (el: HTMLTextAreaElement, text: string) => {
  el.value = text;
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
};
const foot = (t: HTMLElement) => `${Math.round(t.scrollTop)}/${t.scrollHeight - t.clientHeight}`;
const settle = async (ms = 120) => {
  await tick();
  await wait(ms);
};
const out: string[] = [];
const say = (s: string) => out.push(s);
const qs = () => a.turns.map((t) => t.question.slice(0, 22) + (t.answer === null && !t.cancelled && !t.error ? "(asking)" : "")).join(" | ");

async function drive(): Promise<void> {
  await wait(300);
  const t = asideT();
  if (!t) {
    if (act) say("NO ASIDE TRANSCRIPT");
  } else if (act === "edit" || act === "edit-undo") {
    // Edit the 2nd question → Ask again → the 2nd and later exchanges are replaced by one asking.
    press($('[aria-label="Edit this message"]', userTurns(t)[1]!));
    await settle();
    const box = $<HTMLTextAreaElement>(".editor textarea", t);
    say(`editor ${box ? "open" : "MISSING"} · send label "${$(".editor-row .ns-btn", t)?.textContent?.trim()}" · Save ${$$(".editor-row .ns-btn", t).some((b) => b.textContent?.trim() === "Save") ? "SHOWN" : "absent"}`);
    if (box) type(box, "Edited: what if the unit half-lands?");
    await settle();
    press($(".editor-row .ns-btn", t));
    await settle(250);
    say(`after Ask again: ${qs()} · asks ${asks.length} · editor ${$(".editor", t) ? "STILL OPEN" : "closed"} · toast "${app.toasts.at(-1)?.text}"`);
    asideTurnEvent(a.turns.at(-1)!, { type: "text_delta", text: "A new answer begins to arrive. " } as never);
    await settle();
    if (act === "edit-undo") {
      runToastAction(app.toasts.at(-1)!.id);
      await settle(250);
      say(`after Undo: ${a.turns.length} exchanges: ${qs()} · cancelled seqs ${cancelled.join(",")}`);
    }
  } else if (act === "rewind" || act === "rewind-undo") {
    press($('[aria-label="Rewind to here"]', userTurns(t)[2]!));
    await settle(500);
    say(`after Rewind: ${a.turns.length} exchanges · box "${readDraft(asideDraftKey(a)).text}" · toast "${app.toasts.at(-1)?.text}"`);
    if (act === "rewind-undo") {
      runToastAction(app.toasts.at(-1)!.id);
      await settle(300);
      say(`after Undo: ${a.turns.length} exchanges · box "${readDraft(asideDraftKey(a)).text}"`);
    }
  } else if (act === "redo" || act === "retry") {
    const b =
      act === "redo"
        ? $('[aria-label="Redo the reply to this message"]', t)
        : $$("button", t).filter((x) => /retry|again/i.test(`${x.getAttribute("aria-label") ?? ""} ${x.textContent ?? ""}`)).at(-1);
    say(`${act} button ${b ? `found ("${b.getAttribute("aria-label") ?? b.textContent?.trim()}")` : "MISSING"}`);
    press(b);
    await settle(250);
    say(`after ${act}: ${qs()} · asks ${asks.length} · toast "${app.toasts.at(-1)?.text}"`);
    asideTurnEvent(a.turns.at(-1)!, { type: "text_delta", text: "Answering the same question again. " } as never);
    await settle();
  } else if (act === "reply") {
    // Select a paragraph of the aside's answer: one pill, the aside's (no
    // Ask aside in it), and Reply quotes into the aside's box, not the chat's.
    const p = $$(".markdown p", t).at(-1)!;
    const r = document.createRange();
    r.selectNodeContents(p);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
    document.dispatchEvent(new Event("selectionchange"));
    await settle(200);
    const pills = $$(".aside-pill");
    say(`pills ${pills.length} · buttons [${pills.map((x) => $$("button", x).map((b) => b.textContent?.trim().replace(/\s+/g, " ")).join(",")).join(" ; ")}]`);
    if (q.get("click") === "1" && pills[0]) {
      press($$("button", pills[0]).at(-1));
      await settle(250);
      say(`aside box "${readDraft(asideDraftKey(a)).text.slice(0, 60)}" · chat box "${readDraft("chat-a").text.slice(0, 30)}"`);
    }
  } else if (act === "esc" || act === "esc-dirty") {
    press($('[aria-label="Edit this message"]', userTurns(t).at(-1)!));
    await settle();
    const box = $<HTMLTextAreaElement>(".editor textarea", t)!;
    if (act === "esc-dirty") {
      type(box, "Half-typed edit that must not be lost");
      await settle();
    }
    key(box, "Escape");
    await settle(200);
    say(`after Escape: editor ${$(".editor", t) ? "open" : "closed"} · dialog ${$('[aria-modal="true"]') ? "up" : "none"} · card ${v === "tab" ? "n/a" : $(".aside-card") ? "there" : "GONE"} · discard ask ${app.asideDiscard ? "UP" : "none"} · asides ${app.asides.length}`);
    if (act === "esc-dirty" && q.get("again") === "1") {
      // A second Escape with the focus on the dialog (inside the card): it
      // closes the dialog and keeps the edit; the card stays.
      const d = $('[aria-modal="true"]');
      d?.focus();
      key(d ?? box, "Escape");
      await settle(200);
      say(`after 2nd Escape: editor ${$(".editor", t) ? "open" : "closed"} with "${$<HTMLTextAreaElement>(".editor textarea", t)?.value}" · dialog ${$('[aria-modal="true"]') ? "UP" : "closed"} · card ${v === "tab" ? "n/a" : $(".aside-card") ? "there" : "GONE"} · asides ${app.asides.length}`);
    }
  } else if (act === "settle") {
    // The streaming answer grows, then its result lands: one copy of the
    // answer; a reader scrolled up (`up=1`) keeps his lines.
    const turn = a.turns.at(-1)!;
    for (let i = 0; i < 12; i++) {
      asideTurnEvent(turn, { type: "text_delta", text: `More of the answer, line ${i}. ${para}\n\n` } as never);
      await settle(30);
    }
    const before = { foot: foot(t), live: $$("[data-nav-live]", t).length, replies: $$(".assistant", t).length };
    if (q.get("up") === "1") {
      t.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
      t.scrollTop -= 400;
      await settle(150);
    }
    const top = Math.round(t.scrollTop);
    const line = () => {
      const el = $$(".markdown p", t).find((p) => p.textContent?.startsWith("More of the answer, line 8."));
      return el ? Math.round(el.getBoundingClientRect().top) : null;
    };
    const lineTop = line();
    // What `runAside` does when the result arrives.
    const whole = turn.partial;
    settleAsideSegments(turn, whole);
    turn.answer = whole;
    turn.usage = { input_tokens: 190_000, output_tokens: 900, cache_read_tokens: 188_342 };
    turn.at = new Date().toISOString();
    await settle(400);
    const copies = (t.textContent ?? "").split("More of the answer, line 11.").length - 1;
    say(`streaming: scroll ${before.foot} live ${before.live} replies ${before.replies} → settled: scroll ${foot(t)} (was ${top}) · line 8 at y ${line()} (was ${lineTop}) · live ${$$("[data-nav-live]", t).length} · replies ${$$(".assistant", t).length} · copies of the last line ${copies}`);
  } else if (act === "shrink") {
    // The card's room shrinks (a shorter window, another card above the
    // composer): a view at the foot stays at the foot (item 233).
    const card = $(".aside-card")!;
    const b0 = foot(t);
    const h0 = t.clientHeight;
    card.style.maxHeight = `${Number(q.get("to") ?? 320)}px`;
    await settle(300);
    say(`before ${b0} (h ${h0}) → after ${foot(t)} (h ${t.clientHeight}) · at foot ${t.scrollHeight - t.scrollTop - t.clientHeight < 8}`);
  }
  await settle(150);
  const tt = asideT();
  const s = (sel: string) => document.querySelectorAll(sel).length;
  const head = $(".aside-head");
  const base =
    q.get("cap") === "1"
      ? (tt
          ? `transcript ${tt.clientWidth}x${tt.clientHeight} scroll ${foot(tt)} · turns ${$$("[data-turn]", tt).length} · thinking rows open ${$$('[aria-expanded="true"]', tt).length} · canvas ${s("canvas.dot-field")} dotfield ${tt.classList.contains("dotfield")} · rail ${s("nav, .navigator")} · jump ${s(".jump-down")}`
          : "no aside transcript") +
        ` · aside-thread ${s(".aside-thread")} · transcripts ${s(".transcript")}` +
        (head ? ` · fold btn ${$$(".fold-btn", head).length} · title "${$(".aside-view-name")?.textContent?.trim()}"` : "")
      : "";
  cap.textContent = [...out, base].filter(Boolean).join("\n");
  // &report=<port>: the caption also goes to a local listener, so a run can be read as text.
  if (q.get("report")) new Image().src = `http://localhost:${q.get("report")}/cap?${encodeURIComponent(cap.textContent ?? "")}`;
}
void drive().catch((e) => {
  cap.textContent = `driver error: ${e}`;
  if (q.get("report")) new Image().src = `http://localhost:${q.get("report")}/cap?${encodeURIComponent(cap.textContent)}`;
});
