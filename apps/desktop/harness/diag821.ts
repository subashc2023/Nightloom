// Item 821 harness — see diag821.html. The real AssistantMessage (Jarvis) / AssistantMessageClassic, the phone's
// renderer, or a note/file tab's `renderMarkdown`, with `installDiagrams()` drawing every ```mermaid / ```svg block.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import { mount } from "svelte";
import AssistantMessage from "../src/lib/AssistantMessage.svelte";
import AssistantMessageClassic from "../src/lib/AssistantMessageClassic.svelte";
import { renderMarkdown } from "../src/lib/markdown";
import { installDiagrams } from "../src/lib/diagrams";
import { viewSet } from "../src/lib/viewState";
import { diagramOf, sourceKey } from "../src/lib/diagramBlock";

const q = new URLSearchParams(location.hash.slice(1));
const which = q.get("case") ?? "all";
const root = document.getElementById("root")!;
const cap = document.getElementById("cap")!;
const say = (s: string) => (cap.textContent += (cap.textContent ? "\n" : "") + s);

const FLOW = [
  "How a reply reaches the phone:",
  "",
  "```mermaid",
  "flowchart LR",
  "  A[Model streams a reply] --> B{Fence closed?}",
  "  B -- no --> C[Show the source]",
  "  B -- yes --> D[Draw in the sandbox]",
  "  D --> E[(Picture cache)]",
  "  E --> F[Mac transcript]",
  "  E --> G[Phone]",
  "```",
].join("\n");
const SEQ = [
  "The handshake:",
  "",
  "```mermaid",
  "sequenceDiagram",
  "  participant P as Phone",
  "  participant L as Listener",
  "  participant S as Service",
  "  P->>L: GET /chats",
  "  L->>S: list()",
  "  S-->>L: 12 chats",
  "  L-->>P: 200 OK",
  "  Note over P,L: over the tailnet",
  "```",
].join("\n");
const BROKEN = ["A block that does not parse:", "", "```mermaid", "flowchart TD", "  A[Start] --> ", "  --> B((", "```"].join("\n");
const SVG = [
  "An SVG with a script and an onload in it (neither may run):",
  "",
  "```svg",
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120" viewBox="0 0 320 120" onload="top.__svgRan = \'onload\'">',
  "  <script>top.__svgRan = 'script'; parent.__svgRan = 'script';</script>",
  '  <rect x="10" y="10" width="300" height="100" rx="14" fill="#1c212a" stroke="#ffb454" stroke-width="2"/>',
  '  <circle cx="60" cy="60" r="28" fill="#86d8f7"/>',
  '  <text x="110" y="68" font-family="system-ui" font-size="22" fill="#e9edf2">Drawn as an image</text>',
  '  <image href="https://example.com/beacon.png" width="1" height="1"/>',
  "</svg>",
  "```",
].join("\n");
const CASES: Record<string, string> = { flow: FLOW, seq: SEQ, broken: BROKEN, svg: SVG, all: [FLOW, SEQ, BROKEN, SVG].join("\n\n") };
let text = CASES[which] ?? CASES.all;
const stream = q.get("stream");
if (stream) text = text.slice(0, Number(stream));

if (q.get("source") === "1") {
  // The first block as Source: its kept choice, set the way the toggle sets it.
  const t = document.createElement("template");
  t.innerHTML = renderMarkdown(text);
  const first = t.content.querySelector(".md-diagram");
  const d = first ? diagramOf(first) : null;
  if (d) viewSet(sourceKey(d.key), true, false);
}

installDiagrams();

if (q.get("phone") === "1") {
  if (q.get("scheme") === "light") {
    document.documentElement.dataset.scheme = "light";
    document.documentElement.style.cssText =
      "--paper:#f6f4ef;--sheet:#efece5;--raised:#ffffff;--well:#e6e2d9;--term:#fbfaf7;--ink:#1d1b17;--dim:#6b665c;--line:#d9d4c8;--accent:#b8651b;--accent-ink:#8a4a10;--signal:#1b6f8f;color-scheme:light";
    document.querySelector('meta[name="color-scheme"]')!.setAttribute("content", "light");
  }
  root.classList.add("phone");
  const d = document.createElement("div");
  d.className = "md markdown";
  d.innerHTML = renderMarkdown(text, { breaks: true, localImagesAsText: true });
  root.appendChild(d);
} else if (q.get("surface") === "note") {
  // A note's or a markdown file tab's renderer (FileView's `.body.markdown`).
  const d = document.createElement("div");
  d.className = "body markdown";
  d.innerHTML = renderMarkdown("# A note\n\n" + text);
  root.appendChild(d);
} else {
  const Reply = q.get("layout") === "classic" ? AssistantMessageClassic : AssistantMessage;
  mount(Reply, { target: root, props: { segs: [{ kind: "text", text }], streaming: !!stream, headed: false, since: Date.now() } as never });
}

setTimeout(() => {
  const blocks = Array.from(document.querySelectorAll<HTMLElement>(".md-diagram"));
  const w = window as unknown as { __svgRan?: string };
  say(
    `case=${which}${stream ? ` stream=${stream}` : ""}: ${blocks.length} diagram blocks, plain mermaid/svg code blocks outside them ${
      Array.from(document.querySelectorAll("code.language-mermaid, code.language-svg")).filter((c) => !c.closest(".md-diagram")).length
    }, renderer frames ${document.querySelectorAll("iframe.md-diagram-renderer").length} [${Array.from(document.querySelectorAll("iframe.md-diagram-renderer"))
      .map((f) => `sandbox="${f.getAttribute("sandbox")}"`)
      .join("; ")}]`,
  );
  for (const b of blocks) {
    const m = b.querySelector(".md-diagram-mount");
    const img = b.querySelector<HTMLImageElement>("img.md-diagram-img");
    say(
      `  ${b.dataset.diagram}: ${m?.className.replace("md-diagram-mount", "").trim() || "(not drawn)"}` +
        `${img ? ` img ${img.naturalWidth}x${img.naturalHeight} shown ${Math.round(img.getBoundingClientRect().width)}x${Math.round(img.getBoundingClientRect().height)}` : ""}` +
        `${m?.querySelector(".md-diagram-status")?.textContent ? ` status: ${m.querySelector(".md-diagram-status")!.textContent}` : ""}` +
        `; live <svg> drawings inside the block (icons in buttons aside): ${Array.from(b.querySelectorAll("svg")).filter((s) => !s.closest("button")).length}`,
    );
  }
  say(`top.__svgRan = ${w.__svgRan === undefined ? "undefined (nothing in the SVG ran)" : JSON.stringify(w.__svgRan)}`);
  const res = performance.getEntriesByType("resource").filter((r) => !r.name.startsWith(location.origin) && !r.name.startsWith("data:"));
  say(`loads from outside this origin by the harness window: ${res.length}`);
}, Number(q.get("wait") ?? 4000));
