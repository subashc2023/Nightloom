// Backlog 380 + 381 harness — see latex381.html.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import { mount } from "svelte";
import FileView from "../src/lib/FileView.svelte";
import tableTex from "./latex381-table.tex?raw";

const q = new URLSearchParams(location.search);
const stage = q.get("stage") ?? "ok";
const name = q.get("file") ?? "table.tex";
const palette = q.get("palette");
if (palette) document.documentElement.dataset.palette = palette;
const cap = document.getElementById("cap")!;
const log = (s: string) => (cap.textContent += s + "\n");

const py = 'import math\n\n# The area of a circle.\ndef area(r: float) -> float:\n    """Return pi r squared."""\n    return math.pi * r ** 2\n\nprint(f"{area(2):.3f}")\n';
const text = name.endsWith(".tex") ? (stage === "error" ? tableTex.replace("\\hline\n  Model", "\\hline\n  \\Modle") : tableTex) : py;
const path = `/Users/him/papers/${name}`;
const errorLog = [
  "This is pdfTeX, Version 3.141592653-2.6-1.40.27 (TeX Live 2025) (preloaded format=pdflatex)",
  "(./table.tex",
  "! Undefined control sequence.",
  "l.7   \\Modle",
  "              & Params & Score \\\\",
  "The control sequence at the end of the top line",
  "! Emergency stop.",
].join("\n");

async function pdf64(): Promise<string> {
  const buf = new Uint8Array(await (await fetch("./latex381-table.pdf")).arrayBuffer());
  let s = "";
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s);
}

(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string) => {
    if (cmd === "read_file_tab")
      return { path, kind: "text", media_type: "text/plain", size: text.length, text, data: null, via: "folder" };
    if (cmd === "render_latex") {
      if (stage === "missing") return { pdf: null, missing_tex: true, log: null, message: null };
      if (stage === "error") return { pdf: null, missing_tex: false, log: errorLog, message: null };
      return { pdf: await pdf64(), missing_tex: false, log: "Output written on table.pdf (1 page).", message: null };
    }
    return null;
  },
  transformCallback: () => 0,
};

mount(FileView, { target: document.getElementById("pane")!, props: { content: { kind: "file", path } as never } });
setTimeout(() => {
  const spans = document.querySelectorAll(".file-view pre code span[class^='hljs-']").length;
  const split = document.querySelector(".tex-split");
  const cols = split ? getComputedStyle(split).gridTemplateColumns.split(" ").length : 0;
  const pane = document.getElementById("pane")!.getBoundingClientRect().width;
  const err = document.querySelector(".tex-error pre")?.textContent ?? "";
  log(
    `file=${name} stage=${stage} pane=${Math.round(pane)}px coloured-spans=${spans} split=${split ? (cols === 2 ? "side-by-side" : "stacked") : "none"}` +
      ` embed=${document.querySelectorAll("embed.pdf").length} buttons=[${Array.from(document.querySelectorAll(".head button")).map((b) => b.textContent?.trim()).join(", ")}]`,
  );
  if (err) log(`error pane: ${err.replace(/\n/g, " ⏎ ")}`);
  const note = document.querySelector(".tex-note")?.textContent;
  if (note) log(`note: ${note.slice(0, 60)}…`);
}, 600);
