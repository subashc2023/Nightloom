// Review of 318 + 1210 (w2d-review, 2026-10-06): sequences the build's harness did not try — a paste over a
// selection, a drag-move, IME composition, a chat switch, a send, 284's Undo button, 315's relabel, Esc while
// composing, a long draft's per-key cost, fast typing — each checked for stale states and an exact round trip.
// ?s= selpaste | drag | ime | switch | send | undobtn | relabel | window | escime | fast | long
// The page writes its findings to #cap and ends with DONE (for a WebKit runner that polls it).
import "../src/app.css";
import { mount, flushSync, tick } from "svelte";
import { app, runMenuCommand } from "../src/lib/state.svelte";
import { composerFormat } from "../src/lib/composerFormat.svelte";
import { readDraft, setDraftText } from "../src/lib/drafts.svelte";

const q = new URLSearchParams(location.search);
const s = q.get("s") ?? "selpaste";
const cap = document.getElementById("cap")!;
const log: string[] = [];
const say = (l: string) => {
  log.push(l);
  cap.textContent = log.join("\n");
};
const J = JSON.stringify;
const KEY = "chat-a";
const seen = new Set<string>([""]);
const short = (t: string) => (t.length > 70 ? `${J(t.slice(0, 30))}…(${t.length})…${J(t.slice(-25))}` : J(t));
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: async () => null, transformCallback: () => 0 };

const box = () => document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
const note = () => seen.add(box().value);
function type(t: string): void {
  box().focus();
  document.execCommand("insertText", false, t);
}
/** An edit as WebKit delivers one the page cannot make natively (beforeinput, the change, input). */
function edit(inputType: string, text: string, from: number, to: number, data: string | null = null): void {
  const ta = box();
  ta.focus();
  ta.setSelectionRange(from, to);
  ta.dispatchEvent(new InputEvent("beforeinput", { inputType, data, bubbles: true, cancelable: true }));
  ta.setRangeText(text, from, to, "end");
  ta.dispatchEvent(new InputEvent("input", { inputType, data, bubbles: true }));
}
function paste(text: string): void {
  const ta = box();
  ta.focus();
  const dt = new DataTransfer();
  dt.setData("text/plain", text);
  const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
  ta.dispatchEvent(ev);
  if (!ev.defaultPrevented) edit("insertFromPaste", text, ta.selectionStart, ta.selectionEnd);
}
function key(init: KeyboardEventInit): boolean {
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  box().dispatchEvent(ev);
  return ev.defaultPrevented;
}
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    flushSync();
    await tick();
  }
  await new Promise<void>((r) => {
    const mc = new MessageChannel();
    mc.port1.onmessage = () => r();
    mc.port2.postMessage(0);
  });
}
let pick = 0;
async function undo(r = "key"): Promise<void> {
  box().focus();
  if (r === "mix") r = ["menu", "key", "native"][pick++ % 3];
  if (r === "menu") runMenuCommand("undo_app");
  else if (r === "key") key({ key: "z", code: "KeyZ", metaKey: true });
  else document.execCommand("undo");
  await settle();
}
async function redo(r = "key"): Promise<void> {
  box().focus();
  if (r === "mix") r = ["menu", "key", "native"][pick++ % 3];
  if (r === "menu") runMenuCommand("redo_app");
  else if (r === "key") key({ key: "z", code: "KeyZ", metaKey: true, shiftKey: true });
  else document.execCommand("redo");
  await settle();
}
/** Undo n, redo n; count states never seen in a forward edit; true when the round trip is exact. */
async function walk(n: number, r = "key"): Promise<{ stale: number; ok: boolean; trail: string[] }> {
  const top = box().value;
  let stale = 0;
  const trail: string[] = [];
  for (let i = 0; i < n; i++) {
    await undo(r);
    const v = box().value;
    if (!seen.has(v)) stale++;
    trail.push("u:" + short(v) + (seen.has(v) ? "" : " STALE"));
  }
  for (let i = 0; i < n; i++) {
    await redo(r);
    const v = box().value;
    if (!seen.has(v)) stale++;
    trail.push("r:" + short(v) + (seen.has(v) ? "" : " STALE"));
  }
  return { stale, ok: box().value === top, trail };
}
const words = (n: number) => Array.from({ length: n }, (_, i) => ["the", "runner", "advances", "only", "on", "success"][i % 6]).join(" ");
const CODE = "def f(x):\n    return x + 1\n\nprint(f(2))";

async function main(): Promise<void> {
  composerFormat.on = false;
  app.activeSessionId = KEY;
  app.sessions = [{ id: KEY, title: "A" }, { id: "chat-b", title: "B" }] as unknown as typeof app.sessions;
  app.connection = { engine: "claude-code" } as unknown as typeof app.connection;
  const { default: Composer } = await import("../src/lib/Composer.svelte");
  mount(Composer, { target: document.getElementById("root")!, props: {} });
  flushSync();
  await tick();
  box().focus();
  say(`s=${s}`);
  const f = ({ selpaste, drag, ime, switchChat, send, undobtn, relabel, window: win, escime, fast, long } as Record<string, () => Promise<void>>)[s === "switch" ? "switchChat" : s];
  await f();
  say("DONE");
}

async function selpaste(): Promise<void> {
  for (const r of ["key", "menu", "native", "mix"]) {
    setDraftText(KEY, "");
    await settle();
    type("one two three");
    note();
    box().setSelectionRange(4, 7);
    await settle();
    paste("TWO-PASTED");
    await settle();
    note();
    type("!");
    note();
    const w = await walk(4, r);
    say(`${r}: forward ${J(box().value)} stale=${w.stale} roundtrip=${w.ok}`);
    await undo(r);
    await undo(r);
    say(`  two undos → ${J(box().value)} sel=${box().selectionStart}-${box().selectionEnd} (want "one two three" sel 4-7)`);
  }
}

async function drag(): Promise<void> {
  type("alpha beta gamma");
  note();
  // WebKit's drag-move inside the box: deleteByDrag then insertFromDrop, each with beforeinput and input.
  edit("deleteByDrag", "", 6, 11);
  note();
  const v = box().value;
  edit("insertFromDrop", " beta", v.length, v.length);
  note();
  await settle();
  say(`after drag-move: ${J(box().value)}`);
  await undo();
  say(`one ⌘Z → ${J(box().value)} (want "alpha beta gamma": the moved word back in place, nothing missing)`);
  await redo();
  say(`⌘⇧Z → ${J(box().value)}`);
  const w = await walk(3);
  say(`walk 3: stale=${w.stale} roundtrip=${w.ok}`);
}

/** IME composition as WebKit drives it: marked text replaced on each update, then committed. */
async function compose(steps: string[], commit: string, spec: boolean): Promise<void> {
  const ta = box();
  const from = ta.selectionStart;
  ta.dispatchEvent(new CompositionEvent("compositionstart", { data: "", bubbles: true }));
  let marked = 0;
  for (const st of steps) {
    edit("insertCompositionText", st, from, from + marked, st);
    marked = st.length;
    note();
    ta.dispatchEvent(new CompositionEvent("compositionupdate", { data: st, bubbles: true }));
  }
  if (spec) {
    edit("deleteCompositionText", "", from, from + marked);
    note();
    edit("insertFromComposition", commit, from, from, commit);
  } else edit("insertCompositionText", commit, from, from + marked, commit);
  note();
  ta.dispatchEvent(new CompositionEvent("compositionend", { data: commit, bubbles: true }));
  await settle();
}
async function ime(): Promise<void> {
  for (const spec of [false, true]) {
    setDraftText(KEY, "");
    await settle();
    type("a ");
    note();
    await compose(["k", "か", "かn", "かん", "かんj", "かんじ"], "漢字", spec);
    type(" ok");
    note();
    const w = await walk(8);
    say(`commit=${spec ? "delete+insertFromComposition" : "insertCompositionText"}: ${J(box().value)} stale=${w.stale} roundtrip=${w.ok}`);
    say("  " + w.trail.slice(0, 8).join(" | "));
  }
  // ⌘Z pressed mid-composition (marked text showing).
  setDraftText(KEY, "");
  await settle();
  type("x ");
  note();
  const ta = box();
  ta.dispatchEvent(new CompositionEvent("compositionstart", { data: "", bubbles: true }));
  edit("insertCompositionText", "かん", 2, 2, "かん");
  note();
  const before = ta.value;
  const prevented = key({ key: "z", code: "KeyZ", metaKey: true, isComposing: true });
  await settle();
  say(`⌘Z while composing: prevented=${prevented} box ${J(before)} → ${J(box().value)}`);
}

async function switchChat(): Promise<void> {
  type("draft A text");
  note();
  await settle();
  app.activeSessionId = "chat-b";
  await settle();
  type("B words");
  await settle();
  app.activeSessionId = KEY;
  await settle();
  say(`back in A: box=${J(box().value)} A=${J(readDraft(KEY).text)} B=${J(readDraft("chat-b").text)}`);
  for (const r of ["key", "menu", "native"]) {
    await undo(r);
    say(`  ⌘Z (${r}) → ${J(box().value)}`);
    await redo(r);
    say(`  ⌘⇧Z (${r}) → ${J(box().value)}`);
  }
  type(" more");
  note();
  await undo();
  say(`typed " more", ⌘Z → ${J(box().value)}; B still ${J(readDraft("chat-b").text)}`);
}

async function send(): Promise<void> {
  type("message one");
  await settle();
  setDraftText(KEY, ""); // as a send clears the box
  await settle();
  for (const r of ["key", "menu", "native"]) {
    await undo(r);
    say(`after send, ⌘Z (${r}) → ${J(box().value)}`);
    await redo(r);
    say(`after send, ⌘⇧Z (${r}) → ${J(box().value)}`);
  }
  type("two");
  note();
  await undo();
  say(`typed "two", ⌘Z → ${J(box().value)}`);
  await redo();
  say(`⌘⇧Z → ${J(box().value)}`);
  // A failed send puts the words back.
  setDraftText(KEY, "");
  await settle();
  setDraftText(KEY, "message one");
  await settle();
  await undo();
  say(`failed-send restore, then ⌘Z → ${J(box().value)}`);
  await redo();
  say(`  ⌘⇧Z → ${J(box().value)}`);
}

async function undobtn(): Promise<void> {
  const LONG = words(2400);
  type("Intro: ");
  paste(LONG);
  await settle();
  const full = box().value;
  const btn = (t: string) => [...document.querySelectorAll<HTMLButtonElement>(".paste-offer button")].find((x) => x.textContent?.trim() === t);
  btn("Make this an attachment")?.click();
  await new Promise((r) => setTimeout(r, 300));
  await settle();
  const conv = box().value;
  say(`converted: box=${short(conv)} chips=${readDraft(KEY).attachments.length}`);
  btn("Undo")?.click();
  await settle();
  say(`Undo button: box back=${box().value === full} chips=${readDraft(KEY).attachments.length}`);
  await redo();
  say(`⌘⇧Z: box=${short(box().value)} converted again=${box().value === conv} chips=${readDraft(KEY).attachments.length} undo row=${!!btn("Undo")}`);
  btn("Undo")?.click();
  await settle();
  type("x");
  await redo();
  say(`Undo button, type "x", ⌘⇧Z: box ends ${J(box().value.slice(-10))} chips=${readDraft(KEY).attachments.length}`);
  await undo();
  say(`⌘Z: box back to the paste=${box().value === full}`);
}

async function relabel(): Promise<void> {
  type("see ");
  note();
  paste(CODE);
  await settle();
  note();
  seen.add("see " + CODE);
  const fenced = box().value;
  setDraftText(KEY, fenced.replace("```python", "```text")); // 315's label menu rewrites the info string so
  await settle();
  note();
  type("Z");
  note();
  const w = await walk(5);
  say(`fenced=${fenced !== "see " + CODE} relabelled=${box().value.includes("```text")} stale=${w.stale} roundtrip=${w.ok}`);
  say("  " + w.trail.join(" | "));
}

async function win(): Promise<void> {
  let reached = 0;
  window.addEventListener("keydown", (e) => {
    if (e.metaKey && (e.code === "KeyZ" || e.code === "KeyY")) reached++;
  });
  type("abc");
  await settle();
  key({ key: "z", code: "KeyZ", metaKey: true });
  key({ key: "z", code: "KeyZ", metaKey: true, shiftKey: true });
  key({ key: "y", code: "KeyY", metaKey: true });
  await settle();
  say(`⌘Z ⌘⇧Z ⌘Y in the box: ${reached} reached the window (App.svelte's ⌘⇧Z would redo twice if >0)`);
}

async function escime(): Promise<void> {
  type("Intro: ");
  paste(words(2400));
  await settle();
  const has = () => !!document.querySelector(".paste-offer .offer-x");
  say(`offer up=${has()}`);
  const p = key({ key: "Escape", code: "Escape", isComposing: true });
  await settle();
  say(`Esc while composing: prevented=${p} offer still up=${has()} (want: up, the Esc is the IME's)`);
  key({ key: "Escape", code: "Escape" });
  await settle();
  say(`Esc: offer up=${has()}`);
}

async function fast(): Promise<void> {
  // 2,000 keys with no pause between them, caret jumps every 50.
  for (let i = 0; i < 2000; i++) {
    if (i % 50 === 49) box().setSelectionRange(Math.floor(box().value.length / 2), Math.floor(box().value.length / 2));
    type(String.fromCharCode(97 + (i % 26)));
    note();
  }
  await settle();
  const top = box().value;
  let k = 0;
  for (let g = 0; g < 400; g++) {
    const b = box().value;
    await undo();
    if (box().value === b) break;
    if (!seen.has(box().value)) say(`STALE at undo ${k}`);
    k++;
  }
  say(`${k} undos to ${J(box().value)}`);
  for (let i = 0; i < k; i++) await redo();
  say(`redo back: exact=${box().value === top} (${top.length} chars)`);
}

async function long(): Promise<void> {
  const big = words(Number(q.get("w") ?? 150000)) + "\n";
  setDraftText(KEY, big);
  await settle();
  box().setSelectionRange(big.length, big.length);
  const t0 = performance.now();
  for (let i = 0; i < 100; i++) {
    type("x");
    flushSync();
  }
  const t1 = performance.now();
  say(`draft ${big.length} chars: ${((t1 - t0) / 100).toFixed(2)} ms a key (100 keys)`);
  const t2 = performance.now();
  for (let i = 0; i < 10; i++) await undo();
  const t3 = performance.now();
  say(`⌘Z: ${((t3 - t2) / 10).toFixed(2)} ms a step; box ends ${J(box().value.slice(-5))}`);
}

void main().catch((e) => say(`error: ${String(e)}\nDONE`));
