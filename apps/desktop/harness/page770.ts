// Item 770 harness — see page770.html.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import { mount } from "svelte";
import AssistantMessage from "../src/lib/AssistantMessage.svelte";
import AssistantMessageClassic from "../src/lib/AssistantMessageClassic.svelte";
import { renderMarkdown } from "../src/lib/markdown";
import { replyPages } from "../src/lib/replyPages";
import { viewSet } from "../src/lib/viewState";
import { pageOf } from "../src/lib/replyPage";
import vega from "./fixtures770/vega.md?raw";
import mermaid from "./fixtures770/mermaid.md?raw";
import katex from "./fixtures770/katex.md?raw";
import three from "./fixtures770/three.md?raw";
import table from "./fixtures770/table.md?raw";
import error from "./fixtures770/error.md?raw";

const q = new URLSearchParams(location.hash.slice(1));
const which = q.get("case") ?? "vega";
const root = document.getElementById("root")!;
const cap = document.getElementById("cap")!;
// 770 review: &capfix=1 pins the caption to the window's top, so a window-sized shot shows what was counted.
if (q.get("capfix") === "1") cap.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:99";
const say = (s: string) => (cap.textContent += (cap.textContent ? "\n" : "") + s);
const CASES: Record<string, string> = {
  vega,
  mermaid,
  katex,
  three,
  table,
  error,
  all: [vega, mermaid, katex].join("\n\n"),
  many: Array.from({ length: 12 }, (_, i) => table.replace("Plan comparison", `Plan comparison ${i + 1}`).replace("Starter", `Starter ${i + 1}`)).join("\n\n"),
};
let text = CASES[which] ?? vega;
const stream = q.get("stream");
if (stream) text = text.slice(0, Number(stream));

window.addEventListener("message", (e) => {
  const d = e.data as { probe?: string } | null;
  if (d && typeof d.probe === "string") say("page: " + d.probe);
});

if (q.get("phone") === "1") {
  // The phone's own renderer and action (Remote.svelte's `.md`), in a phone-wide column.
  if (q.get("scheme") === "light") {
    document.documentElement.dataset.scheme = "light";
    document.documentElement.style.cssText = "--paper:#f6f4ef;--sheet:#efece5;--raised:#ffffff;--well:#e6e2d9;--term:#fbfaf7;--ink:#1d1b17;--dim:#6b665c;--line:#d9d4c8;--accent:#b8651b;--accent-ink:#8a4a10;--signal:#1b6f8f;color-scheme:light";
    document.querySelector('meta[name="color-scheme"]')!.setAttribute("content", "light");
  }
  root.classList.add("phone");
  const d = document.createElement("div");
  d.className = "md markdown";
  d.innerHTML = renderMarkdown(text, { breaks: true, localImagesAsText: true });
  root.appendChild(d);
  replyPages(d, {});
} else {
  if (q.get("source") === "1") {
    // The first page, as Source: its kept choice, set the way the card's button sets it.
    const t = document.createElement("template");
    t.innerHTML = renderMarkdown(text, { localImagesAsText: true });
    const first = t.content.querySelector(".md-page");
    const p = first ? pageOf(first) : null;
    if (p) viewSet(`page.source:${p.key}`, true, false);
  }
  const Reply = q.get("layout") === "classic" ? AssistantMessageClassic : AssistantMessage;
  mount(Reply, { target: root, props: { segs: [{ kind: "text", text }], streaming: !!stream, headed: false, since: Date.now() } as never });
}

setTimeout(() => {
  const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-reply-page]"));
  const frames = Array.from(document.querySelectorAll<HTMLIFrameElement>("iframe"));
  say(
    `case=${which}${stream ? ` stream=${stream}` : ""}: ${document.querySelectorAll(".md-page").length} page blocks, ${cards.length} cards, ${frames.length} live frames` +
      ` [${frames.map((f) => `${Math.round(f.getBoundingClientRect().width)}x${Math.round(f.getBoundingClientRect().height)} sandbox="${f.getAttribute("sandbox")}"`).join("; ")}]` +
      `, writing boxes ${document.querySelectorAll(".md-page-writing").length}, plain code blocks ${document.querySelectorAll(".markdown > pre").length}`,
  );
  for (const c of cards) {
    const strip = c.querySelector(".strip")?.textContent?.replace(/\s+/g, " ").trim();
    say(`card "${c.querySelector(".rp-title")?.textContent}": buttons [${Array.from(c.querySelectorAll(".rp-btn")).map((b) => b.textContent?.trim()).join(", ")}]${strip ? ` strip: ${strip}` : ""}`);
  }
  const res = performance.getEntriesByType("resource").filter((r) => !r.name.startsWith(location.origin));
  say(`loads from outside this origin by the harness window: ${res.length}`);
}, Number(q.get("wait") ?? 3200));
