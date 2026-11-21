// Item 820 harness — see reply820.html. The pictures are real files in
// fixtures820/ (a matplotlib PNG and SVG, an ffmpeg test clip, an SVG with a
// script in it); the fake bridge answers `read_reply_media` with their bytes.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import { mount, flushSync } from "svelte";
import AssistantMessage from "../src/lib/AssistantMessage.svelte";
import { app } from "../src/lib/state.svelte";
import type { Segment } from "../src/lib/state.svelte";

const TYPES: Record<string, string> = { png: "image/png", svg: "image/svg+xml", mp4: "video/mp4" };
const calls: string[] = [];
async function b64(name: string): Promise<{ data: string; size: number }> {
  const r = await fetch(`./fixtures820/${name}`);
  if (!r.ok) throw new Error("missing");
  const buf = new Uint8Array(await r.arrayBuffer());
  let s = "";
  for (const b of buf) s += String.fromCharCode(b);
  return { data: btoa(s), size: buf.length };
}
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    calls.push(cmd);
    if (cmd === "named_files") return (args.paths as string[]).map(() => null);
    if (cmd === "read_reply_media") {
      const path = String(args.path);
      const name = path.slice(path.lastIndexOf("/") + 1);
      const ext = name.slice(name.lastIndexOf(".") + 1);
      if (name === "old.png") throw `${path} is no longer on disk`;
      const { data, size } = await b64(name);
      return { path, kind: ext === "mp4" ? "video" : "image", media_type: TYPES[ext], size, data };
    }
    return null;
  },
  transformCallback: () => 0,
};
const q = new URLSearchParams(location.search);
document.documentElement.dataset.palette = q.get("p") ?? "A";
const root = document.getElementById("root")!;
const cap = document.getElementById("cap")!;
root.style.width = `${q.get("w") ?? "760"}px`;

const P = "/Users/demo/work/stats";
const ok = (content: string) => ({ content, is_error: false });
const evil = q.get("evil") === "1";
const text = evil
  ? "Here is the badge as an SVG — it has a `<script>` in it, which a picture must never run:\n\n![badge](/tmp/nl820/evil.svg)"
  : [
      "I ran the script; the line plot is saved at `/tmp/nl820/plot.png`:",
      "",
      "![Two signals](/tmp/nl820/plot.png)",
      "",
      "The bar chart went to `bars.svg` in the project folder, and a 2-second clip of the run is at /tmp/nl820/clip.mp4.",
      "",
      "The earlier draft, ![old plot](old.png), was deleted after this run.",
    ].join("\n");
const segs = [
  {
    kind: "tool",
    call: {
      id: "t1",
      name: "Bash",
      input: { command: "python3 plot.py", description: "Plot the two signals" },
      result: ok("saved plot.png, bars.svg, clip.mp4"),
    },
  },
  { kind: "text", text },
] as unknown as Segment[];

(app as unknown as { connection: unknown }).connection = { workspace: P };
app.activeSessionId = "chat-820";
document.title = "harness 820";
mount(AssistantMessage, {
  target: root,
  props: { segs, footer: { model: "opus", usage: { input_tokens: 9000, output_tokens: 320 }, stop_reason: "end_turn" } as never },
});
flushSync();
setTimeout(() => {
  if (q.get("big") === "1") document.querySelector<HTMLButtonElement>(".rm-thumb")?.click();
  setTimeout(() => {
    const imgs = [...document.querySelectorAll<HTMLImageElement>(".rm-strip img")];
    const sizes = imgs.map((i) => `${i.naturalWidth}x${i.naturalHeight}`).join(",");
    const vids = document.querySelectorAll(".rm-strip video").length;
    const inlineSvg = document.querySelectorAll(".rm-strip svg, .markdown svg:not(.katex svg)").length;
    const ran = (window as unknown as { __svgRan?: number }).__svgRan === 1;
    cap.textContent =
      `imgs ${imgs.length} [${sizes}] · videos ${vids} · inline <svg> in strip ${inlineSvg} · ` +
      `title "${document.title}" · body bg "${document.body.style.background}" · script ran ${ran} · ${[...new Set(calls)].join(",")}`;
  }, 1200);
}, 400);
