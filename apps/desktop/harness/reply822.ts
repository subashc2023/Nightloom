// Item 822 harness — see reply822.html. fixtures822/ holds real output of the
// drawing toolchain, made by the exact commands the engine note (DRAW_NOTE)
// gives a chat: `dot -Tpng g.dot -o g.png` and
// `~/.nightloom/draw-env/bin/manim -ql scene.py Name` (a 5.07 s H.264 clip at
// media/videos/scene/480p15/Name.mp4). The fake bridge answers
// `read_reply_media` with their bytes; the reply names them by absolute path,
// as the note asks.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import { mount, flushSync } from "svelte";
import AssistantMessage from "../src/lib/AssistantMessage.svelte";
import { app } from "../src/lib/state.svelte";
import type { Segment } from "../src/lib/state.svelte";

const TYPES: Record<string, string> = { png: "image/png", mp4: "video/mp4" };
const asked: string[] = [];
async function b64(name: string): Promise<{ data: string; size: number }> {
  const r = await fetch(`./fixtures822/${name}`);
  if (!r.ok) throw new Error("missing");
  const buf = new Uint8Array(await r.arrayBuffer());
  let s = "";
  for (const b of buf) s += String.fromCharCode(b);
  return { data: btoa(s), size: buf.length };
}
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "named_files") return (args.paths as string[]).map(() => null);
    if (cmd === "read_reply_media") {
      const path = String(args.path);
      asked.push(path);
      const name = path.slice(path.lastIndexOf("/") + 1);
      const ext = name.slice(name.lastIndexOf(".") + 1);
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

const P = "/Users/demo/work/draw";
const ok = (content: string) => ({ content, is_error: false });
const text = [
  "The pipeline graph is drawn with Graphviz at /Users/demo/work/draw/g.png, and the 5-second Manim clip",
  "(circle to square, then a quarter turn) is at /Users/demo/work/draw/media/videos/scene/480p15/Name.mp4.",
].join("\n");
const segs = [
  {
    kind: "tool",
    call: {
      id: "t1",
      name: "Bash",
      input: { command: "dot -Tpng g.dot -o g.png", description: "Draw the pipeline graph" },
      result: ok(""),
    },
  },
  {
    kind: "tool",
    call: {
      id: "t2",
      name: "Bash",
      input: { command: "~/.nightloom/draw-env/bin/manim -ql scene.py Name", description: "Render the 5-second clip" },
      result: ok("INFO     Rendered Name\n         Played 4 animations"),
    },
  },
  { kind: "text", text },
] as unknown as Segment[];

(app as unknown as { connection: unknown }).connection = { workspace: P };
app.activeSessionId = "chat-822";
document.title = "harness 822";
mount(AssistantMessage, {
  target: root,
  props: { segs, footer: { model: "opus", usage: { input_tokens: 9000, output_tokens: 120 }, stop_reason: "end_turn" } as never },
});
flushSync();
setTimeout(() => {
  const imgs = [...document.querySelectorAll<HTMLImageElement>(".rm-strip img")];
  const sizes = imgs.map((i) => `${i.naturalWidth}x${i.naturalHeight}`).join(",");
  const vids = [...document.querySelectorAll<HTMLVideoElement>(".rm-strip video")];
  const vinfo = vids.map((v) => `${v.duration.toFixed(2)}s ${v.videoWidth}x${v.videoHeight}`).join(",");
  cap.textContent =
    `imgs ${imgs.length} [${sizes}] · videos ${vids.length} [${vinfo}] · read_reply_media asked: ${asked.join(" | ")}`;
}, 1600);
