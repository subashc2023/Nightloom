// Item 276 harness — see composer276-full.html.
import "../src/app.css";
import "katex/dist/katex.min.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import { mount } from "svelte";
import Composer from "../src/lib/Composer.svelte";
import { app } from "../src/lib/state.svelte";
import { composerFormat } from "../src/lib/composerFormat.svelte";

const q = new URLSearchParams(location.search);
document.documentElement.dataset.palette = q.get("p") ?? "A";
composerFormat.on = q.get("format") !== "0";
app.activeSessionId = "chat-a";
app.sessions = [{ id: "chat-a", title: "A chat" }] as unknown as typeof app.sessions;
app.connection = { engine: "claude-code" } as unknown as typeof app.connection;
mount(Composer, { target: document.getElementById("root")!, props: {} });
(window as unknown as { __app: typeof app }).__app = app;

// Fix pass (2026-10-01): a recorder for the interactive runs. R(label) logs
// the editor's text and selection after a real keystroke or click; SAVE(name)
// writes the log to harness/steps276/<name>.json through the scratch dev
// server's /__save/ route, for composer276-steps.html to replay into snaps.
import { EditorView } from "@codemirror/view";
type Rec = { label: string; doc: string; anchor: number; head: number };
const w = window as unknown as Record<string, unknown>;
w.__rec = [] as Rec[];
w.V = () => EditorView.findFromDOM(document.querySelector<HTMLElement>(".cm-editor")!);
w.R = (label: string) => {
  const v = (w.V as () => EditorView | null)();
  if (!v) return "no editor";
  const s = v.state;
  const r = { label, doc: s.doc.toString(), anchor: s.selection.main.anchor, head: s.selection.main.head };
  (w.__rec as Rec[]).push(r);
  return `${JSON.stringify(r)} focus=${v.hasFocus} widgets=${document.querySelectorAll(".cm-nmath").length}`;
};
w.SAVE = async (name: string) => {
  const r = await fetch(`/__save/${name}`, { method: "POST", body: JSON.stringify(w.__rec, null, 1) });
  w.__rec = [];
  return r.text();
};
