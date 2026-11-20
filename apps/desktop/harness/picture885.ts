// Item 885 harness — see picture885.html. The picture is fixtures820/plot.png, read through a fake bridge.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import { mount, flushSync } from "svelte";
import ReplyMedia from "../src/lib/ReplyMedia.svelte";
import "../src/lib/replyMediaMac"; // the Mac loader (read_reply_media through the fake bridge)

async function b64(name: string): Promise<{ data: string; size: number }> {
  const r = await fetch(`./fixtures820/${name}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  let s = "";
  for (const b of buf) s += String.fromCharCode(b);
  return { data: btoa(s), size: buf.length };
}
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "read_reply_media") {
      const path = String(args.path);
      const { data, size } = await b64("plot.png");
      return { path, kind: "image", media_type: "image/png", size, data };
    }
    return null;
  },
  transformCallback: () => 0,
};
const q = new URLSearchParams(location.search);
document.documentElement.dataset.palette = "A";
const cap = document.getElementById("cap")!;
mount(ReplyMedia, {
  target: document.getElementById("root")!,
  props: { items: [{ path: "/tmp/nl885/plot.png", written: "/tmp/nl885/plot.png", explicit: true }] as never, chat: "chat-885", onopen: () => {} },
});
flushSync();
const at = (el: Element, fx: number, fy: number) => {
  const r = el.getBoundingClientRect();
  return { clientX: r.left + fx * r.width, clientY: r.top + fy * r.height, bubbles: true };
};
const report = (what: string) => {
  const stage = document.querySelector<HTMLElement>("[data-picture-viewer]");
  const img = stage?.querySelector("img");
  const r = img?.getBoundingClientRect();
  cap.textContent = `${what} · viewer ${stage ? "open" : "closed"} · zoom ${stage?.dataset.zoom ?? "-"} · picture ${r ? `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}` : "-"} · window ${innerWidth}x${innerHeight}`;
};
setTimeout(() => {
  document.querySelector<HTMLButtonElement>(".rm-thumb")?.click();
  setTimeout(() => {
    const img = document.querySelector("[data-picture-viewer] img")!;
    const stage = document.querySelector("[data-picture-viewer]")!;
    const c = q.get("click");
    if (c === "corner" || c === "twice") img.dispatchEvent(new MouseEvent("click", at(img, 0.08, 0.1)));
    if (c === "twice") img.dispatchEvent(new MouseEvent("click", at(img, 0.5, 0.5)));
    if (c === "outside") stage.dispatchEvent(new MouseEvent("click", { clientX: 5, clientY: innerHeight / 2, bubbles: true }));
    if (q.get("pinch") === "1") stage.dispatchEvent(new WheelEvent("wheel", { ...at(img, 0.5, 0.5), ctrlKey: true, deltaY: -60, cancelable: true }));
    setTimeout(() => report(c ? `after click=${c}` : q.get("pinch") ? "after pinch" : "at fit"), 200);
  }, 500);
}, 600);
