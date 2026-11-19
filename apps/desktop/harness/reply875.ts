// Item 875 harness — see reply875.html. The pictures are 820's fixtures (a
// matplotlib PNG and SVG, an ffmpeg clip), inlined as data URLs so the built
// page is one self-contained file; the fake bridge answers
// `read_reply_media` with their bytes, and `gone.png` as deleted.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import { mount, flushSync } from "svelte";
import AssistantMessage from "../src/lib/AssistantMessage.svelte";
import AssistantMessageClassic from "../src/lib/AssistantMessageClassic.svelte";
import ReplyMedia from "../src/lib/ReplyMedia.svelte";
import { app } from "../src/lib/state.svelte";
import { applyLayout, layout } from "../src/lib/layout.svelte";
import { renderMarkdown } from "../src/lib/markdown";
import { replyMediaInline, stripMedia } from "../src/lib/replyMediaInline";
import { setMediaLoader, blobOf } from "../src/lib/replyMediaStore.svelte";
import { mediaKindOf } from "../src/lib/replyMedia";
import plotPng from "./fixtures820/plot.png?inline";
import barsSvg from "./fixtures820/bars.svg?inline";
import clipMp4 from "./fixtures820/clip.mp4?inline";

const q = new URLSearchParams((window as unknown as { __h9q?: string }).__h9q ?? location.hash.slice(1));
const root = document.getElementById("root")!;
const cap = document.getElementById("cap")!;
const say = (s: string) => (cap.textContent += (cap.textContent ? "\n" : "") + s);

const FIX: Record<string, { url: string; type: string }> = {
  "plot.png": { url: plotPng, type: "image/png" },
  "bare.png": { url: plotPng, type: "image/png" },
  "bars.svg": { url: barsSvg, type: "image/svg+xml" },
  "clip.mp4": { url: clipMp4, type: "video/mp4" },
};
// Vite inlines an SVG as a URL-encoded data: URL, not base64 (review: the shot showed "invalid characters").
const b64Of = (dataUrl: string) => {
  const body = dataUrl.slice(dataUrl.indexOf(",") + 1);
  if (/;base64,/.test(dataUrl.slice(0, dataUrl.indexOf(",") + 1))) return body;
  const bytes = new TextEncoder().encode(decodeURIComponent(body));
  let bin = "";
  for (const x of bytes) bin += String.fromCharCode(x);
  return btoa(bin);
};
function fixture(path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const f = FIX[name];
  if (!f) throw new Error(`${path} is no longer on disk`);
  const data = b64Of(f.url);
  return { name, data, type: f.type, size: Math.floor((data.length * 3) / 4) };
}
const calls: string[] = [];
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    calls.push(cmd);
    if (cmd === "named_files") return (args.paths as string[]).map(() => null);
    if (cmd === "read_reply_media") {
      const path = String(args.path);
      let f;
      try {
        f = fixture(path);
      } catch (e) {
        throw (e as Error).message;
      }
      return { path, kind: mediaKindOf(path), media_type: f.type, size: f.size, data: f.data };
    }
    return null;
  },
  transformCallback: () => 0,
};

const D = "/tmp/nl875";
const text = [
  "I ran the script. First the two signals over the run:",
  "",
  `![Two signals over time](${D}/plot.png)`,
  "",
  "The warm signal leads the cool one by about a quarter period, and both settle after step 40. Next, the totals by group:",
  "",
  `![Totals by group](${D}/bars.svg)`,
  "",
  `Group C is the outlier. A short clip of the run is here: ![The run, 2 s](${D}/clip.mp4)`,
  "",
  `The earlier draft ![old draft](${D}/gone.png) was deleted.`,
  "",
  `Files: the plot is ${D}/plot.png again, and the raw frame dump is ${D}/bare.png.`,
].join("\n");
const stream = q.get("stream");
const shown = stream ? text.slice(0, Number(stream)) : text;
document.title = "harness 875";

if (q.get("phone") === "1") {
  // The phone's own renderer, action and strip (Remote.svelte's settled `.md` and the ReplyMedia under it).
  root.classList.add("phone");
  setMediaLoader(async (path) => {
    const f = fixture(path);
    return { kind: mediaKindOf(path) ?? "image", mediaType: f.type, size: f.size, bytes: blobOf(f.data, f.type) };
  });
  const d = document.createElement("div");
  d.className = "md markdown";
  d.innerHTML = renderMarkdown(shown, { breaks: true, localImagesAsText: true });
  root.appendChild(d);
  replyMediaInline(d, { chat: "chat-875" });
  const strip = document.createElement("div");
  root.appendChild(strip);
  mount(ReplyMedia, { target: strip, props: { items: stripMedia(shown, []), chat: "chat-875" } });
} else {
  const classic = q.get("classic") === "1";
  if (classic) {
    layout.value = "classic";
    applyLayout("classic");
  }
  root.style.width = q.get("w") ? `${q.get("w")}px` : "100%";
  (app as unknown as { connection: unknown }).connection = { workspace: D };
  app.activeSessionId = "chat-875";
  const segs = [
    { kind: "tool", call: { id: "t1", name: "Bash", input: { command: "python3 plot.py", description: "Plot the run" }, result: { content: "saved", is_error: false } } },
    { kind: "text", text: shown },
  ];
  mount(classic ? AssistantMessageClassic : AssistantMessage, {
    target: root,
    props: { segs, streaming: !!stream, footer: { model: "opus", usage: { input_tokens: 9000, output_tokens: 320 }, stop_reason: "end_turn" } } as never,
  });
}
flushSync();
setTimeout(() => {
  if (q.get("big") === "1") document.querySelector<HTMLButtonElement>("[data-reply-media='inline'] .rm-thumb, .md-media .rm-thumb")?.click();
  setTimeout(() => {
    const inl = document.querySelectorAll(".md-media .rm-item img, .md-media .rm-item video").length;
    const strip = document.querySelectorAll("[data-reply-media='strip'] .rm-item img, [data-reply-media='strip'] .rm-item video").length;
    const lines = [...document.querySelectorAll(".md-media .rm-line")].map((e) => e.textContent?.trim().replace(/\s+/g, " "));
    const order = [...document.querySelectorAll(".md-media, [data-reply-media='strip']")].map((e) =>
      e.matches(".md-media") ? decodeURIComponent(e.getAttribute("data-media-src") ?? "").split("/").pop() : "STRIP",
    );
    const tallest = Math.max(0, ...[...document.querySelectorAll<HTMLElement>(".rm-item img, .rm-item video")].map((e) => e.getBoundingClientRect().height));
    say(
      `${q.get("phone") === "1" ? "phone" : q.get("classic") === "1" ? "classic" : "jarvis"}${stream ? ` stream=${stream}` : ""} · inline drawn ${inl} · strip drawn ${strip} · ` +
        `order ${order.join(" > ")} · tallest ${Math.round(tallest)}px · inline lines: ${lines.join(" | ") || "none"} · ${[...new Set(calls)].join(",")}`,
    );
  }, 1500);
}, 400);
