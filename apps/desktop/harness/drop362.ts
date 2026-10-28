// Item 362 — the shipped drop look on the real Transcript + Composer (see drop362.html).
import "@fontsource-variable/newsreader/wght.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "../src/app.css";
import { mount, flushSync, tick } from "svelte";
import { app } from "../src/lib/state.svelte";
import { composerFormat } from "../src/lib/composerFormat.svelte";
import { readDraft } from "../src/lib/drafts.svelte";
import type { SessionEvent } from "../src/lib/types";
import { pdfFile, pngFile } from "./files362";
import { drop } from "../src/lib/dropLook.svelte";

const q = new URLSearchParams(location.search);
const s = q.get("s") ?? "chat";
const n = Number(q.get("n") ?? 1);
const t = Number(q.get("t") ?? 0);
if (q.get("palette")) document.documentElement.dataset.palette = q.get("palette")!;
if (q.get("rm") === "1") {
  const real = window.matchMedia.bind(window);
  window.matchMedia = ((m: string) =>
    m.includes("reduced-motion") ? ({ matches: true, media: m, addEventListener() {}, removeEventListener() {} } as unknown as MediaQueryList) : real(m)) as typeof window.matchMedia;
}
const tag = document.getElementById("tag")!;
// The snap tool's offscreen snapshot drops a layer with a backdrop filter (seen 2026-10-15): off unless ?bf=1.
if (q.get("bf") !== "1") document.head.insertAdjacentHTML("beforeend", "<style>*{backdrop-filter:none!important}</style>");
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string) => (cmd === "turn_usage" ? [] : null),
  transformCallback: () => 0,
};
const yieldNow = () =>
  new Promise<void>((r) => {
    const c = new MessageChannel();
    c.port1.onmessage = () => r();
    c.port2.postMessage(0);
  });
const at = new Date(Date.now() - 50 * 60_000).toISOString();
const reply = (text: string): SessionEvent =>
  ({ event: "assistant_message", model: "claude-opus-5-5", blocks: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 10 }, at }) as SessionEvent;

async function main() {
  composerFormat.on = false;
  app.connection = { engine: "claude-code", contextLimit: 200_000 } as unknown as typeof app.connection;
  app.activeSessionId = "chat-a";
  app.sessions = [{ id: "chat-a", title: "ICS 46 — project 2 trees" }] as unknown as typeof app.sessions;
  app.events = [
    { event: "user_message", text: "why does my AVL rotate twice on this insert?", at } as SessionEvent,
    reply("The insert lands in the right subtree of the left child, so a single right rotation would only move the imbalance across; the first rotation straightens the zig-zag and the second fixes the height.\n\nIf you have the diagram from lecture, send it and I will check your tree against it node by node."),
  ];
  const { default: Transcript } = await import("../src/lib/Transcript.svelte");
  const { default: Composer } = await import("../src/lib/Composer.svelte");
  mount(Transcript, { target: document.getElementById("tr")!, props: {} });
  mount(Composer, { target: document.getElementById("root")!, props: {} });
  flushSync();
  await tick();
  const ta = document.querySelector<HTMLTextAreaElement>(".composer textarea")!;
  ta.setRangeText("Can you check my tree against the lecture's diagram?", 0, 0, "end");
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  const files = n >= 3 ? [await pngFile(), pdfFile("lecture-07-avl.pdf"), pdfFile("project2-spec.pdf")] : [await pngFile()];
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  const card = document.querySelector(".composer .card")!.getBoundingClientRect();
  const trr = document.querySelector(".transcript")!.getBoundingClientRect();
  const onChat = s === "chat" || s === "dropchat";
  const target = onChat ? document.querySelector(".transcript .inner") ?? document.querySelector(".transcript")! : ta;
  const x = onChat ? card.left + card.width * 0.62 : card.left + card.width * 0.8;
  const y = onChat ? trr.top + trr.height * 0.35 : card.top + card.height * 0.42;
  // Let the page paint first: the offscreen snapshot missed a layer filled in before the first paint.
  await new Promise((r) => setTimeout(r, Number(q.get("wait") ?? 1500)));
  const fire = (type: string) => target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: y }));
  fire("dragenter");
  fire("dragover");
  const dropped = s === "drop" || s === "dropchat";
  let nAnims = 0;
  if (dropped) {
    fire("drop");
    // The chips mount once the files are read; then every animation is paused at the frame.
    for (let i = 0; i < 200 && readDraft("chat-a").attachments.length < files.length; i++) await yieldNow();
    for (let i = 0; i < 10; i++) await yieldNow();
    flushSync();
    // The frames follow pick362's clock: the drop from t=0.2 to 0.5 (the landing's 420 ms), the chips from 0.45
    // to 1 (their 520 ms, each one starting its own stagger later).
    const landMs = Math.max(0, ((t - 0.2) / 0.3) * 420);
    const chipMs = Math.max(0, ((t - 0.45) / 0.55) * 520);
    // Svelte starts a transition with a placeholder animation as long as its delay, holding the first frame,
    // and makes the real one when it finishes; an offscreen view never runs the frame that finishes it. Finish the placeholders
    // (remembering each delay), let the real animations start, then pause everything at the frame.
    const target = (a: Animation) => (a.effect as KeyframeEffect | null)?.target as Element | null;
    const delays = new Map<Element, number>();
    for (const a of document.getAnimations()) {
      const el = target(a);
      if (!el || el.closest(".landing")) continue;
      delays.set(el, Number(a.effect?.getTiming().duration ?? 0));
      // `finish` alone queues `onfinish` for a frame that never comes here; call Svelte's handler directly.
      const done = a.onfinish;
      a.onfinish = null;
      a.finish();
      done?.call(a, new AnimationPlaybackEvent("finish"));
    }
    for (let i = 0; i < 10; i++) await yieldNow();
    nAnims = document.getAnimations().length;
    for (const a of document.getAnimations()) {
      const el = target(a);
      a.pause();
      a.currentTime = el?.closest(".landing") ? landMs : Math.max(0, chipMs - (el ? (delays.get(el) ?? 0) : 0));
    }
  }
  await tick();
  // The snap tool's offscreen WKWebView did not paint elements made after the first paint under the drop layer
  // or the chip row (seen 2026-10-15: in the DOM, topmost by hit-test, computed styles right, unpainted), while a
  // copy made at the end paints. So each is swapped for a copy carrying its frame's animated values inline.
  if (q.get("freeze") !== "0" && !q.has("dbg")) freeze([...document.querySelectorAll<HTMLElement>(".drop-layer > *, .composer .attachments")]);
  const comp = document.querySelector(".composer")!;
  tag.textContent = `362 · s=${s} n=${n}${dropped ? ` t=${t}` : ""}${q.get("rm") === "1" ? " rm" : ""} · dropping=${comp.classList.contains("dropping")} · chips=${readDraft("chat-a").attachments.length} · anims=${nAnims} · kind=${drop.kind} chatEl=${!!document.querySelector("[data-drop-chat]")} layer=${document.querySelector(".drop-layer")?.children.length ?? "none"}`;
  if (q.has("dbg")) {
    tag.textContent += " ANIMS " + document.getAnimations().map((a) => `${((a.effect as KeyframeEffect).target as Element)?.className}:${a.playState}:${Math.round(Number(a.currentTime))}/${a.effect?.getTiming().duration}`).join(" ; ");
    const row = document.querySelector(".composer .attachments");
    tag.textContent += ` ROW h=${row ? getComputedStyle(row).height : "none"} chips=${[...document.querySelectorAll(".composer .attachment")].map((e) => { const c = getComputedStyle(e); return `${c.width}/${c.opacity}`; }).join(",")}`;
    document.body.insertAdjacentHTML("beforeend", '<div style="position:fixed;left:100px;top:300px;width:200px;height:100px;background:red;z-index:40"></div>');
    const l = document.querySelector<HTMLElement>(".drop-layer");
    if (q.get("dbg") === "2" && l) { l.style.background = "rgba(255,0,0,.3)"; const c = l.cloneNode(true) as HTMLElement; c.style.background = ""; document.body.append(c); }
    { const z = document.querySelector<HTMLElement>(".drop-layer .zone"); if (z) { const r = z.getBoundingClientRect(); z.style.pointerEvents = "auto"; const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); tag.textContent += ` ZR=${JSON.stringify(r)} hit=${hit?.tagName}.${hit?.className} vw=${innerWidth}x${innerHeight}`; } }
    if (q.get("dbg") === "6" && l) { l.style.background = "rgba(255,0,0,.3)"; }
    if (q.get("dbg") === "7" && l) { l.style.background = "rgba(255,0,0,.3)"; for (const c of l.querySelectorAll<HTMLElement>(".veil,.zone")) c.style.outline = "3px solid lime"; }
    if (q.get("dbg") === "3") { const z = document.querySelector<HTMLElement>(".drop-layer .zone"); if (z) z.style.background = "lime"; }
    const cs = (sel: string) => { const e = document.querySelector(sel); if (!e) return sel + ":none"; const c = getComputedStyle(e); return `${sel}: pos=${c.position} disp=${c.display} op=${c.opacity} vis=${c.visibility} z=${c.zIndex} bg=${c.backgroundColor} bd=${c.borderTopStyle}/${c.borderTopColor} clip=${c.clipPath} parent=${e.parentElement?.tagName}`; };
    tag.textContent += " | " + cs(".drop-layer") + " | " + cs(".drop-layer .veil") + " | " + cs(".drop-layer .zone");
  }
}
function freeze(roots: HTMLElement[]) {
  const animated = new Set(document.getAnimations().map((a) => (a.effect as KeyframeEffect | null)?.target).filter(Boolean));
  for (const root of roots) {
    const copy = root.cloneNode(true) as HTMLElement;
    const from = [root, ...root.querySelectorAll<HTMLElement>("*")];
    const to = [copy, ...copy.querySelectorAll<HTMLElement>("*")];
    from.forEach((el, i) => {
      if (!animated.has(el)) return;
      const c = getComputedStyle(el);
      for (const k of ["transform", "opacity", "width", "height", "box-shadow"]) to[i].style.setProperty(k, c.getPropertyValue(k));
      const ring = c.getPropertyValue("--drop-ring");
      if (ring) to[i].style.setProperty("--drop-ring", ring);
    });
    root.replaceWith(copy);
  }
}
void main();
