// Item 885 harness — a Notes image (NoteMedia) in a pane: a click near its top-left corner zooms there;
// then the view is unmounted and mounted again (leaving the note and coming back) and the caption says
// whether the zoom was kept. Picture: fixtures820/plot.png.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import { mount, unmount, flushSync } from "svelte";
import NoteMedia from "../src/lib/NoteMedia.svelte";

document.documentElement.dataset.palette = "A";
const root = document.getElementById("root")!;
root.style.cssText = "position:fixed; inset:30px 0 0 0; display:flex; flex-direction:column; padding:0;";
const cap = document.getElementById("cap")!;
const r = await fetch("./fixtures820/plot.png");
const buf = new Uint8Array(await r.arrayBuffer());
let bin = "";
for (const b of buf) bin += String.fromCharCode(b);
const file = { path: "/demo/notes/plot.png", kind: "image", media_type: "image/png", size: buf.length, text: null, data: btoa(bin), via: "folder" };
const props = { file: file as never, name: "plot.png" };
let view = mount(NoteMedia, { target: root, props });
flushSync();
const zoom = () => document.querySelector<HTMLElement>("[data-picture-viewer]")?.dataset.zoom ?? "-";
setTimeout(() => {
  const img = document.querySelector("[data-picture-viewer] img")!;
  const b = img.getBoundingClientRect();
  img.dispatchEvent(new MouseEvent("click", { clientX: b.left + 0.08 * b.width, clientY: b.top + 0.1 * b.height, bubbles: true }));
  const first = zoom();
  unmount(view);
  view = mount(NoteMedia, { target: root, props });
  flushSync();
  setTimeout(() => {
    const p = document.querySelector("[data-picture-viewer] img")!.getBoundingClientRect();
    cap.textContent = `Notes image · after a corner click: zoom ${first} · after leaving and coming back: zoom ${zoom()} · picture ${Math.round(p.left)},${Math.round(p.top)} ${Math.round(p.width)}x${Math.round(p.height)} · window ${innerWidth}x${innerHeight}`;
  }, 500);
}, 700);
