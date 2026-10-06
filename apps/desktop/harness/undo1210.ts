// Blocker 1210 + item 318 harness — see undo1210.html.
// ?s= seq1210 (the blocker's sequence) | convert (284's "Make this an attachment", then undo/redo) | fuzz (seeded
// random edits, script edits, undos and redos; &seed= &n=) | offer (the long-paste offer, for the shot) |
// dismiss-esc | dismiss-x (item 318).
// ?r= the route ⌘Z / ⌘⇧Z take: menu (the Edit menu, `runMenuCommand`), key (the key in the box), native
// (`execCommand`, as the context menu's Undo would), mix (each step picks one).
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import { mount, flushSync, tick } from "svelte";
import { app, runMenuCommand } from "../src/lib/state.svelte";
import { composerFormat } from "../src/lib/composerFormat.svelte";
import { readDraft, setDraftText } from "../src/lib/drafts.svelte";

const q = new URLSearchParams(location.search);
const s = q.get("s") ?? "seq1210";
const route = q.get("r") ?? "menu";
const cap = document.getElementById("cap")!;
const log: string[] = [];
const say = (l: string) => {
  log.push(l);
  cap.textContent = log.join("\n");
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;
const KEY = "chat-a";
/** Every state the box was in by a forward edit; an undo or redo may only land on one of these. */
const seen = new Set<string>([""]);

const words = (n: number) =>
  Array.from({ length: n }, (_, i) => (i % 12 === 11 ? "watermark.\n" : ["the", "runner", "advances", "only", "on", "success", "and", "redoes", "a", "failed", "unit", "—"][i % 12])).join(" ");
const LONG = words(2431);
const CODE = "def f(x):\n    return x + 1\n\nprint(f(2))";

(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async () => null,
  transformCallback: () => 0,
};

function box(): HTMLTextAreaElement {
  return document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
}

/** Typing as WebKit does it: the real `insertText` command (beforeinput, input, and WebKit's own undo stack). */
function type(t: string): void {
  box().focus();
  document.execCommand("insertText", false, t);
}
function backspace(n: number): void {
  box().focus();
  for (let i = 0; i < n; i++) document.execCommand("delete");
}

/** A ⌘V paste as WebKit delivers it; if the page lets it through, the text lands at the caret as a paste. */
function paste(text: string): boolean {
  const ta = box();
  ta.focus();
  // Item 315's first ⌘Z after a code paste gives the paste as it came, unfenced: a state the box had in effect.
  seen.add(ta.value.slice(0, ta.selectionStart) + text + ta.value.slice(ta.selectionEnd));
  const dt = new DataTransfer();
  dt.setData("text/plain", text);
  const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
  ta.dispatchEvent(ev);
  if (!ev.defaultPrevented) {
    const bi = new InputEvent("beforeinput", { inputType: "insertFromPaste", data: null, bubbles: true, cancelable: true });
    ta.dispatchEvent(bi);
    ta.setRangeText(text.replace(/\r\n?/g, "\n"), ta.selectionStart, ta.selectionEnd, "end");
    ta.dispatchEvent(new InputEvent("input", { inputType: "insertFromPaste", bubbles: true }));
  }
  return ev.defaultPrevented;
}

function keydown(init: KeyboardEventInit): boolean {
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  box().dispatchEvent(ev);
  return ev.defaultPrevented;
}

let pick = 0;
function routeNow(): string {
  if (route !== "mix") return route;
  return ["menu", "key", "native"][pick++ % 3];
}
async function undo(): Promise<void> {
  box().focus();
  const r = routeNow();
  if (r === "menu") runMenuCommand("undo_app");
  else if (r === "key") keydown({ key: "z", code: "KeyZ", metaKey: true });
  else document.execCommand("undo");
  await settle();
}
async function redo(): Promise<void> {
  box().focus();
  const r = routeNow();
  if (r === "menu") runMenuCommand("redo_app");
  else if (r === "key") {
    // ⌘⇧Z and ⌘Y, alternately (the window's spelling and the menu's).
    if (pick++ % 2) keydown({ key: "z", code: "KeyZ", metaKey: true, shiftKey: true });
    else keydown({ key: "y", code: "KeyY", metaKey: true });
  } else document.execCommand("redo");
  await settle();
}
async function settle(): Promise<void> {
  // Ticks, not timers: a page in an off-screen WebKit view has its timers throttled to ~1 s.
  for (let i = 0; i < 3; i++) {
    flushSync();
    await tick();
  }
  // And one task boundary (a MessageChannel post, which WebKit does not throttle), as between two keys he presses.
  await new Promise<void>((r) => {
    const mc = new MessageChannel();
    mc.port1.onmessage = () => r();
    mc.port2.postMessage(0);
  });
}

function offerRow(): string {
  return document.querySelector(".paste-offer")?.textContent?.replace(/\s+/g, " ").trim() ?? "(none)";
}
function chipCount(): number {
  return readDraft(KEY).attachments.length;
}
const short = (t: string) => (t.length > 70 ? `${J(t.slice(0, 30))}…(${t.length} chars)…${J(t.slice(-25))}` : J(t));

async function composer(): Promise<void> {
  composerFormat.on = false;
  app.activeSessionId = KEY;
  app.sessions = [{ id: KEY, title: "A chat" }] as unknown as typeof app.sessions;
  app.connection = { engine: "claude-code" } as unknown as typeof app.connection;
  const { default: Composer } = await import("../src/lib/Composer.svelte");
  mount(Composer, { target: document.getElementById("root")!, props: {} });
  flushSync();
  await tick();
  box().focus();
  let bi = 0;
  box().addEventListener("beforeinput", (e) => {
    if (e.inputType.startsWith("history")) bi++;
  }, true);
  (window as unknown as { biCount: () => number }).biCount = () => bi;
  say(`route=${route}`);
  if (s === "seq1210") return seq1210();
  if (s === "convert") return convert();
  if (s === "fuzz") return fuzz();
  return dismiss();
}

function note(): void {
  seen.add(box().value);
}

async function seq1210(): Promise<void> {
  type("hello ");
  note();
  const fenced = paste(CODE);
  await settle();
  note();
  type("X");
  note();
  say(`forward: ${J(box().value)} (fenced=${fenced})`);
  let stale = 0;
  for (let i = 1; i <= 5; i++) {
    await undo();
    const v = box().value;
    if (!seen.has(v)) stale++;
    say(`undo ${i}: ${J(v)}${seen.has(v) ? "" : "  <-- STALE"}`);
  }
  for (let i = 1; i <= 5; i++) {
    await redo();
    const v = box().value;
    if (!seen.has(v)) stale++;
    say(`redo ${i}: ${J(v)}${seen.has(v) ? "" : "  <-- STALE"}`);
  }
  const final = "hello \n```python\n" + CODE + "\n```X";
  say(`native history beforeinput events seen: ${(window as unknown as { biCount: () => number }).biCount()}`);
  say(`RESULT stale=${stale} roundtrip=${box().value === final ? "ok" : "LOST " + J(box().value)}`);
}

async function convert(): Promise<void> {
  type("Please summarise this: ");
  note();
  paste(LONG);
  await settle();
  note();
  const full = box().value;
  const b = [...document.querySelectorAll<HTMLButtonElement>(".paste-offer button")].find((x) => x.textContent?.trim() === "Make this an attachment");
  b?.click();
  await wait(200);
  await settle();
  note();
  type(" — thanks");
  note();
  const final = box().value;
  say(`forward: box=${short(final)} chips=${chipCount()}`);
  let stale = 0;
  for (let i = 1; i <= 4; i++) {
    await undo();
    const v = box().value;
    if (!seen.has(v)) stale++;
    say(`undo ${i}: box=${short(v)} chips=${chipCount()}${v === full ? " (paste back in the box)" : ""}${seen.has(v) ? "" : "  <-- STALE"}`);
  }
  for (let i = 1; i <= 4; i++) {
    await redo();
    const v = box().value;
    if (!seen.has(v)) stale++;
    say(`redo ${i}: box=${short(v)} chips=${chipCount()}${seen.has(v) ? "" : "  <-- STALE"}`);
  }
  // Nothing he typed lost: the words are in the box or in the chip.
  const v = box().value;
  const kept = v.includes("Please summarise this:") && (v.includes(LONG.slice(0, 200)) || chipCount() > 0);
  say(`RESULT stale=${stale} his text kept=${kept} roundtrip=${v === final && chipCount() === 1 ? "ok (box and chip as before)" : "DIFFERS"}`);
}

/** mulberry32: a seeded generator, so a failing run can be replayed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function fuzz(): Promise<void> {
  const seed = Number(q.get("seed") ?? 1);
  const n = Number(q.get("n") ?? 300);
  const rand = rng(seed);
  const W = ["alpha ", "beta ", "gamma ", "delta\n", "eps ", "zeta. "];
  let stale = 0, undos = 0, redos = 0, still = 0;
  const firstStale: string[] = [];
  for (let i = 0; i < n; i++) {
    const x = rand();
    const ta = box();
    if (x < 0.3) {
      type(W[Math.floor(rand() * W.length)]);
      note();
    } else if (x < 0.4) {
      const p = Math.floor(rand() * (ta.value.length + 1));
      ta.setSelectionRange(p, p);
      type("<" + i + ">");
      note();
    } else if (x < 0.48) {
      backspace(1 + Math.floor(rand() * 4));
      note();
    } else if (x < 0.52) {
      paste(CODE);
      await settle();
      note();
    } else if (x < 0.56) {
      // A script-set edit, as Reply's quote or a clip pick makes one.
      setDraftText(KEY, ta.value + "\n> quoted " + i + "\n");
      await settle();
      note();
    } else if (x < 0.8) {
      const before = ta.value;
      await undo();
      undos++;
      const v = box().value;
      if (v === before) still++;
      if (!seen.has(v)) {
        stale++;
        if (firstStale.length < 2) firstStale.push(`op ${i} undo → ${short(v)}`);
      }
    } else {
      const before = ta.value;
      await redo();
      redos++;
      const v = box().value;
      if (v === before) still++;
      if (!seen.has(v)) {
        stale++;
        if (firstStale.length < 2) firstStale.push(`op ${i} redo → ${short(v)}`);
      }
    }
    await settle();
  }
  // Round trip: undo all the way down, then redo as many steps back up. (Redo all the way would also replay
  // steps the run had undone before it ended.) A route may miss a key (the native one, when WebKit's own stack
  // is empty), so three misses in a row end a direction.
  const top = box().value;
  let k = 0;
  for (let miss = 0, guard = 0; miss < 3 && guard < 400; guard++) {
    const b = box().value;
    await undo();
    if (box().value === b) miss++;
    else {
      miss = 0;
      k++;
    }
  }
  const bottom = box().value;
  for (let m = 0, miss = 0, guard = 0; m < k && miss < 3 && guard < 400; guard++) {
    const b = box().value;
    await redo();
    if (box().value === b) miss++;
    else {
      miss = 0;
      m++;
    }
  }
  say(`seed=${seed} ops=${n} undos=${undos} redos=${redos} no-change=${still} STALE=${stale}`);
  for (const f of firstStale) say(`  first stale: ${f}`);
  say(`round trip: ${k} undos down to ${short(bottom)}; redo back ${box().value === top ? "equals the box before (ok)" : "DIFFERS: " + short(box().value) + " vs " + short(top)}`);
}

async function dismiss(): Promise<void> {
  type("Please summarise this: ");
  paste(LONG);
  await settle();
  const full = box().value;
  say(`after ⌘V: offer row: ${offerRow()}`);
  if (s === "offer") return;
  if (s === "dismiss-esc") {
    const prevented = keydown({ key: "Escape", code: "Escape" });
    say(`Esc (prevented=${prevented})`);
  } else {
    const x = document.querySelector<HTMLButtonElement>(".paste-offer button.offer-x");
    say(`× button: ${x ? `found, aria-label=${J(x.getAttribute("aria-label"))}` : "MISSING"}`);
    x?.click();
  }
  await settle();
  say(`after dismiss: offer row: ${offerRow()}; box unchanged=${box().value === full}; chips=${chipCount()}`);
  type(" more");
  await settle();
  await undo();
  say(`after typing and ⌘Z: offer row: ${offerRow()}; box back to the paste=${box().value === full}`);
  // A second, different long paste still gets its own offer.
  box().setSelectionRange(box().value.length, box().value.length);
  paste(" " + words(2100));
  await settle();
  say(`a new long paste: offer row: ${offerRow()}`);
}

void composer().catch((e) => say(`error: ${String(e)}`));
