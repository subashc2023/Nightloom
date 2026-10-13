// Item 312 harness — see chip312.html. ?s= attach (⌥⌘V), convert (Make this an attachment), undo (convert, then
// Undo), image (⌥⌘V with an image: must not fade). ?t= ms into the fade at which the page freezes it (omit: let it
// finish). ?rm=1: reduced motion.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import { mount, flushSync, tick } from "svelte";
import { app } from "../src/lib/state.svelte";
import { composerFormat } from "../src/lib/composerFormat.svelte";
import { readDraft } from "../src/lib/drafts.svelte";

const q = new URLSearchParams(location.search);
const s = q.get("s") ?? "attach";
const t = q.has("t") ? Number(q.get("t")) : null;
const cap = document.getElementById("cap")!;
const log: string[] = [];
const say = (l: string) => {
  log.push(l);
  cap.textContent = log.join("\n");
};

const words = (n: number) =>
  Array.from({ length: n }, (_, i) => (i % 12 === 11 ? "watermark.\n" : ["the", "runner", "advances", "only", "on", "success", "and", "redoes", "a", "failed", "unit", "—"][i % 12])).join(" ");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

let clipboard: { text: string; png?: boolean } = { text: "" };
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string) => {
    if (cmd === "paste_into_focus") {
      void yieldNow().then(() => paste(clipboard.text, clipboard.png));
      return true;
    }
    return null;
  },
  transformCallback: () => 0,
};

const box = () => document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
function paste(text: string, png = false): void {
  const ta = box();
  ta.focus();
  const dt = new DataTransfer();
  if (text) dt.setData("text/plain", text);
  if (png) {
    const bytes = Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0));
    dt.items.add(new File([bytes], "image.png", { type: "image/png" }));
  }
  const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
  ta.dispatchEvent(ev);
  if (!ev.defaultPrevented && text) {
    ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, "end");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }
}
function click(label: string): void {
  const b = [...document.querySelectorAll<HTMLButtonElement>(".paste-offer button")].find((x) => x.textContent?.trim() === label);
  if (!b) throw new Error(`no button ${label}`);
  b.click();
}
// A hidden WKWebView (bin/snap) neither ticks animations nor runs short timers on time, so the page yields by
// MessageChannel and steps Svelte's animations by hand: Svelte first runs a zero-length placeholder (the delay),
// whose finish starts the fade itself.
const yieldNow = () => new Promise<void>((r) => {
  const c = new MessageChannel();
  c.port1.onmessage = () => r();
  c.port2.postMessage(0);
});
const onChip = (a: Animation) => {
  const tg = (a.effect as KeyframeEffect | null)?.target;
  return tg instanceof Element && tg.classList.contains("attachment");
};
// WebKit hidden: finish() does not dispatch `finish` either (events go out with a rendering update that never
// comes), so the page calls the handler Svelte set, once.
function kick(a: Animation): void {
  a.finish();
  const f = a.onfinish;
  if (f) {
    a.onfinish = null;
    f.call(a, new AnimationPlaybackEvent("finish"));
  }
}
const dur = (a: Animation) => Number(a.effect?.getComputedTiming().duration ?? 0);
const chipOpacity = () => [...document.querySelectorAll(".attachment")].map((e) => Number(getComputedStyle(e).opacity).toFixed(2)).join(",") || "(no chip)";
const rowHeight = () => Math.round(document.querySelector(".composer")?.getBoundingClientRect().height ?? 0);

/** Step past placeholders until the chip's fade runs (or none comes); returns the fades. */
async function fades(): Promise<Animation[]> {
  const until = performance.now() + 2500;
  while (performance.now() < until) {
    await yieldNow();
    const all = document.getAnimations().filter(onChip);
    for (const a of all) if (dur(a) === 0) kick(a);
    const real = all.filter((a) => dur(a) > 0);
    if (real.length > 0) return real;
  }
  return [];
}
async function settle(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    await yieldNow();
    for (const a of document.getAnimations().filter(onChip)) kick(a);
  }
}

/** Freeze the chip's fade at ?t= ms (or run it out) and say what is on screen. */
async function freeze(what: string): Promise<void> {
  const anims = await fades();
  const d = anims[0] ? dur(anims[0]) : undefined;
  if (t !== null) for (const a of anims) {
    a.pause();
    a.currentTime = t;
  }
  else await settle();
  say(`${what}: chip fades=${anims.length}${d !== undefined ? ` (duration ${d} ms)` : ""}; frozen at ${t ?? "end"} ms; chip opacity=${chipOpacity()}; composer height=${rowHeight()} px; box chars=${box().value.length}; chips=${readDraft("chat-a").attachments.map((a) => a.name).join(",") || "none"}`);
}

async function main(): Promise<void> {
  composerFormat.on = false;
  app.activeSessionId = "chat-a";
  app.sessions = [{ id: "chat-a", title: "A chat" }] as unknown as typeof app.sessions;
  app.connection = { engine: "claude-code" } as unknown as typeof app.connection;
  const { default: Composer } = await import("../src/lib/Composer.svelte");
  mount(Composer, { target: document.getElementById("root")!, props: {} });
  flushSync();
  await tick();
  const ta = box();
  ta.focus();
  ta.setRangeText(s === "attach" || s === "image" ? "Notes from today, attached: " : "Please summarise this: ", 0, 0, "end");
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
  say(`reduced motion=${matchMedia("(prefers-reduced-motion: reduce)").matches}`);
  if (s === "attach" || s === "image") {
    clipboard = s === "image" ? { text: "", png: true } : { text: words(1240) };
    ta.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "√", code: "KeyV", metaKey: true, altKey: true }));
    for (let i = 0; i < 20; i++) await yieldNow();
    await freeze(s === "image" ? "⌥⌘V, an image" : "⌥⌘V, 1,240 words");
    return;
  }
  paste(words(2431));
  for (let i = 0; i < 20; i++) await yieldNow();
  const full = ta.value;
  click("Make this an attachment");
  if (s === "convert") {
    await freeze("Make this an attachment");
    return;
  }
  await fades();
  await settle();
  say(`converted: chip opacity=${chipOpacity()}; box chars=${ta.value.length}`);
  click("Undo");
  await freeze("Undo");
  say(`box restored exactly=${box().value === full}`);
}

void main().catch((e) => say(`error: ${String(e)}`));
