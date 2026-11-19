// Item 879 harness — see svg879.html. The 4-bit adder from his shot (black lines, no background), a currentColor
// drawing and a Mermaid flowchart, on each surface an SVG draws: a reply (Jarvis / Classic), a note, the phone's
// renderer, an svg file tab (FileView) and the reply's picture strip (ReplyMedia).
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import { mount } from "svelte";
import AssistantMessage from "../src/lib/AssistantMessage.svelte";
import AssistantMessageClassic from "../src/lib/AssistantMessageClassic.svelte";
import FileView from "../src/lib/FileView.svelte";
import ReplyMedia from "../src/lib/ReplyMedia.svelte";
import { setMediaLoader } from "../src/lib/replyMediaStore.svelte";
import { renderMarkdown } from "../src/lib/markdown";
import { installDiagrams } from "../src/lib/diagrams";
import adder from "./adder879.svg?raw";

const q = new URLSearchParams(location.hash.slice(1));
const surface = q.get("surface") ?? "reply";
const root = document.getElementById("root")!;
const cap = document.getElementById("cap")!;
const say = (s: string) => (cap.textContent += (cap.textContent ? "\n" : "") + s);

const THEMED = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 90" width="300" height="90" font-family="Helvetica, Arial, sans-serif" font-size="14">',
  '  <g fill="none" stroke="currentColor" stroke-width="1.5"><rect x="10" y="20" width="100" height="50"/><rect x="190" y="20" width="100" height="50"/><path d="M110 45 H186"/></g>',
  '  <text x="60" y="50" text-anchor="middle" fill="currentColor">half adder</text><text x="240" y="50" text-anchor="middle" fill="currentColor">half adder</text>',
  "</svg>",
].join("\n");
const TEXT = [
  "**Part 2: Chain four full adders and you get a 4-bit adder**",
  "",
  "As a model drew it (black lines, no background):",
  "",
  "```svg",
  adder.trim(),
  "```",
  "",
  "Drawn in currentColor, as the prompt now asks:",
  "",
  "```svg",
  THEMED,
  "```",
  "",
  "And Mermaid:",
  "",
  "```mermaid",
  "flowchart LR",
  "  A0[A0,B0] --> FA0 --> FA1 --> FA2 --> FA3 --> C[Cout]",
  "```",
].join("\n");

if (q.get("scheme") === "light") {
  document.documentElement.dataset.scheme = "light";
  document.documentElement.style.cssText =
    "--paper:#f6f4ef;--sheet:#efece5;--raised:#ffffff;--well:#e6e2d9;--term:#fbfaf7;--ink:#1d1b17;--dim:#6b665c;--line:#d9d4c8;--accent:#b8651b;--accent-ink:#8a4a10;--signal:#1b6f8f;color-scheme:light";
  document.querySelector('meta[name="color-scheme"]')!.setAttribute("content", "light");
}

const b64 = btoa(unescape(encodeURIComponent(adder)));
(window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke = (cmd: string) =>
  cmd === "read_file_tab"
    ? Promise.resolve({ path: "/tmp/adder.svg", kind: "image", media_type: "image/svg+xml", size: adder.length, text: null, data: b64, via: "written" })
    : Promise.resolve(null);

installDiagrams();

// His 2:54 PM report: a transparent PNG of black lines (hw5-q1-alu-boxes.png) on the strip and in a file tab.
// His files are copied beside this harness as his-*.png and never committed; without them a drawn stand-in is used.
async function png(name: string, draw: (c: CanvasRenderingContext2D) => void): Promise<Blob> {
  const r = await fetch(`./${name}`).catch(() => null);
  if (r?.ok && (r.headers.get("content-type") ?? "").startsWith("image/")) return r.blob();
  const cv = document.createElement("canvas");
  cv.width = 490;
  cv.height = 245;
  draw(cv.getContext("2d")!);
  return new Promise((ok) => cv.toBlob((b) => ok(b!), "image/png"));
}
const standIn = (opaque: boolean) => (c: CanvasRenderingContext2D) => {
  if (opaque) (c.fillStyle = "#fff"), c.fillRect(0, 0, 490, 245);
  c.strokeStyle = "#000";
  c.lineWidth = 1.5;
  for (let i = 0; i < 6; i++) (c.fillStyle = "#fff"), c.fillRect(40 + i * 70, 60, 40, 80), c.strokeRect(40 + i * 70, 60, 40, 80);
  c.beginPath();
  c.moveTo(10, 200);
  c.lineTo(480, 200);
  c.stroke();
};
const b64of = async (b: Blob) => btoa(String.fromCharCode(...new Uint8Array(await b.arrayBuffer())));

if (surface === "pngstrip") {
  const alu = await png("his-alu879.png", standIn(false));
  const table = await png("his-optable879.png", standIn(true));
  setMediaLoader(async (path: string) => {
    const b = /alu/.test(path) ? alu : table;
    return { kind: "image", mediaType: "image/png", size: b.size, bytes: b };
  });
  const items = ["hw5-q1-optable.png", "hw5-q1-alu-boxes.png"].map((n) => ({ written: n, path: `/tmp/${n}`, kind: "image", explicit: true }));
  mount(ReplyMedia, { target: root, props: { items, chat: null } as never });
} else if (surface === "pngfile") {
  const alu = await png("his-alu879.png", standIn(false));
  const data = await b64of(alu);
  (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke = (cmd: string) =>
    cmd === "read_file_tab"
      ? Promise.resolve({ path: "/tmp/hw5-q1-alu-boxes.png", kind: "image", media_type: "image/png", size: alu.size, text: null, data, via: "written" })
      : Promise.resolve(null);
  root.style.height = "560px";
  mount(FileView, { target: root, props: { content: { kind: "file", path: "/tmp/hw5-q1-alu-boxes.png" } } as never });
} else if (surface === "phone") {
  root.classList.add("phone");
  const d = document.createElement("div");
  d.className = "md markdown";
  d.innerHTML = renderMarkdown(TEXT, { breaks: true, localImagesAsText: true });
  root.appendChild(d);
} else if (surface === "note") {
  const d = document.createElement("div");
  d.className = "body markdown";
  d.innerHTML = renderMarkdown("# Adders\n\n" + TEXT);
  root.appendChild(d);
} else if (surface === "file") {
  root.style.height = "560px";
  mount(FileView, { target: root, props: { content: { kind: "file", path: "/tmp/adder.svg" } } as never });
} else if (surface === "strip") {
  setMediaLoader(async () => ({ kind: "image", mediaType: "image/svg+xml", size: adder.length, bytes: new Blob([adder], { type: "image/svg+xml" }) }));
  mount(ReplyMedia, { target: root, props: { items: [{ written: "adder.svg", path: "/tmp/adder.svg", kind: "image", explicit: true }], chat: null } as never });
} else {
  const Reply = q.get("layout") === "classic" ? AssistantMessageClassic : AssistantMessage;
  mount(Reply, { target: root, props: { segs: [{ kind: "text", text: TEXT }], streaming: false, headed: false, since: Date.now() } as never });
}

setTimeout(() => {
  const imgs = Array.from(document.querySelectorAll<HTMLImageElement>("#root img"));
  say(`surface=${surface} layout=${q.get("layout") ?? "jarvis"} scheme=${document.documentElement.dataset.scheme ?? "dark"}: ${imgs.length} pictures`);
  for (const img of imgs) {
    const bg = getComputedStyle(img.parentElement!).backgroundColor + " / img " + getComputedStyle(img).backgroundColor;
    const inked = /color%3A|color:/.test(img.src.slice(0, 2000)) ? "inked" : "-";
    say(`  ${img.className || "(img)"} nl-paper=${img.classList.contains("nl-paper")} backing=${img.dataset.backing ?? (img.classList.contains("paper") ? "paper" : "-")} ${inked} bg ${bg} ${img.naturalWidth}x${img.naturalHeight}`);
  }
}, Number(q.get("wait") ?? 4000));
