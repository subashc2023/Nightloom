// Item 819 harness — see html819.html.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import { mount, flushSync } from "svelte";
import FileView from "../src/lib/FileView.svelte";
import NoteView from "../src/lib/NoteView.svelte";
import HtmlPage from "../src/lib/HtmlPage.svelte";
import { viewSet } from "../src/lib/viewState";
import { app } from "../src/lib/state.svelte";

const q = new URLSearchParams(location.search);
const view = q.get("view") ?? "file";
const source = q.get("source") === "1";
const cap = document.getElementById("cap")!;
const log = (s: string) => (cap.textContent += s + "\n");
// Vite serves an .html file with its dev client added, so inputs are fetched as .txt; &name= is the file's name.
const name = q.get("name") ?? (q.get("src") ?? "page.html").split("/").pop()!;
const path = `/Users/him/projects/STATS-67/.agents/notes/${name}`;

window.addEventListener("message", (e) => {
  const d = e.data as { probe?: string } | null;
  if (d && typeof d.probe === "string") log(d.probe);
});

(async () => {
  const text = await (await fetch(q.get("src") ?? "./page.html")).text();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      if (cmd === "read_file_tab") return { path, kind: "html", media_type: "text/html", size: text.length, text, data: null, via: "folder" };
      if (cmd === "read_note_media") return null;
      if (cmd === "read_note") return text;
      return null;
    },
    transformCallback: () => 0,
  };
  const pane = document.getElementById("pane")!;
  if (view === "file") {
    viewSet(`file.plain:${path}`, source, false);
    mount(FileView, { target: pane, props: { content: { kind: "file", path } as never } });
  } else if (view === "note") {
    app.project = { name: "STATS 67", notes_dir: "/Users/him/projects/STATS-67/.agents/notes" } as unknown as typeof app.project;
    viewSet(`note.html.source:project:${name}`, source, false);
    mount(NoteView, { target: pane, props: { note: { scope: "project", name } } });
  } else {
    mount(HtmlPage, { target: pane, props: { html: text, scheme: (q.get("scheme") ?? "dark") as "light" | "dark", place: "bare", title: name } });
  }
  flushSync();
  let loads = 0;
  const watch = () => {
    const f = document.querySelector<HTMLIFrameElement>("iframe");
    if (!f) return setTimeout(watch, 50);
    f.addEventListener("load", () => (loads += 1));
  };
  watch();
  setTimeout(() => {
    const f = document.querySelector<HTMLIFrameElement>("iframe");
    log(
      `view=${view} source=${source} iframe=${f ? `sandbox="${f.getAttribute("sandbox")}" loads=${loads} ${Math.round(f.getBoundingClientRect().width)}x${Math.round(f.getBoundingClientRect().height)}` : "none"}` +
        ` buttons=[${Array.from(document.querySelectorAll("button")).map((b) => b.textContent?.trim()).filter(Boolean).slice(0, 8).join(", ")}]` +
        ` strip="${document.querySelector(".html-page .strip")?.textContent?.replace(/\s+/g, " ").trim() ?? ""}"`,
    );
  }, 2600);
})();
