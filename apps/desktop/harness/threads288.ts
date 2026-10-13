// Backlog 288 harness — see threads288.html.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import { mount, flushSync, tick } from "svelte";
import Sidebar from "../src/lib/Sidebar.svelte";
import ThreadChip from "../src/lib/ThreadChip.svelte";
import { app } from "../src/lib/state.svelte";

const q = new URLSearchParams(location.search);
document.documentElement.dataset.palette = q.get("p") ?? "A";
const view = q.get("view") ?? "open";
const cap = document.getElementById("cap")!;

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const chat = (id: string, title: string, min: number, thread?: string) => ({
  id, title, mode: "normal", kind: "build", modified: ago(min), ...(thread ? { thread } : {}),
});
const sessions = [
  chat("a1f0c2d3-s10", "Stuart 10 — proxy evaluator sizing", 4, "stuart-brainstorm"),
  chat("b2e1d3c4-legal", "Lease clause 7 negotiation", 25),
  chat("c3d2e4f5-s9", "Stuart 9 — what counts as a round", 80, "stuart-brainstorm"),
  chat("d4c3f5a6-ace", "ACE extrapolation, second pass", 190, "ace-extrapolation"),
  chat("e5b4a6b7-misc", "Rename the fixtures folder", 300),
  chat("f6a5b7c8-s8", "Stuart 8 — the replay eval", 1500, "stuart-brainstorm"),
];
const threads = [
  { slug: "stuart-brainstorm", title: "Stuart brainstorm (Deep Thoughts)", status: "As of 2026-10-02, 7:41 PM — proxy stays small; next: size the replay set", touched: "2026-10-02", start_here_words: 410, tokens: 5200, flags: 0 },
  { slug: "ace-extrapolation", title: "ACE extrapolation", status: "As of 2026-10-01, 11:15 PM — concept split reproduced on toy data", touched: "2026-10-01", start_here_words: 300, tokens: 3100, flags: 1 },
  { slug: "proxy-eval", title: "proxy-eval", status: "As of 2026-09-30, 9:02 AM — new thread, nothing yet", touched: "2026-09-30", start_here_words: 40, tokens: 300, flags: 0 },
];

(window as unknown as { __stub: (c: string) => Promise<unknown> }).__stub = async (cmd: string) => {
  switch (cmd) {
    case "list_threads":
      return threads;
    case "list_sessions":
      return sessions;
    default:
      throw `stub: ${cmd}`;
  }
};

if (view === "closed") {
  localStorage.setItem("nightloom.threadsClosed", JSON.stringify(["p1/stuart-brainstorm", "p1/ace-extrapolation"]));
} else {
  localStorage.removeItem("nightloom.threadsClosed");
}
app.project = { id: "p1", name: "Value Generalization", root: "/Users/you/research/value-generalization" } as unknown as typeof app.project;
app.sessions = sessions as unknown as typeof app.sessions;
app.activeSessionId = view === "closed" ? "b2e1d3c4-legal" : "c3d2e4f5-s9";
app.events = [
  { event: "session_created", id: app.activeSessionId, at: ago(80) },
  ...(view === "closed" ? [] : [{ event: "thread", thread: "stuart-brainstorm", at: ago(80) }]),
] as unknown as typeof app.events;

mount(Sidebar, { target: document.getElementById("side")! });
mount(ThreadChip, { target: document.getElementById("bar")! });
flushSync();

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function run() {
  await wait(150);
  await tick();
  if (view === "chip") {
    document.querySelector<HTMLButtonElement>(".thread-chip")?.click();
  } else if (view === "menu") {
    document.querySelector<HTMLButtonElement>(".new-chat.more")?.click();
  } else if (view === "rowmenu") {
    const more = document.querySelectorAll<HTMLButtonElement>(".more-btn")[0];
    more?.click();
    await tick();
    Array.from(document.querySelectorAll<HTMLButtonElement>(".row-menu button")).find((b) => /Move to thread/.test(b.textContent ?? ""))?.click();
  } else if (view === "drag") {
    app.draggingContent = { kind: "chat", session: "b2e1d3c4-legal" } as unknown as typeof app.draggingContent;
    const g = document.querySelectorAll(".thread-group")[1];
    g?.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true }));
  }
  await tick();
  await wait(100);
  const groups = Array.from(document.querySelectorAll(".thread-group")).map((g) => {
    const name = g.querySelector(".tg-name")?.textContent?.trim();
    const n = g.querySelectorAll(".session-row").length;
    return `${name} [${g.classList.contains("drop") ? "drop " : ""}${n} rows]`;
  });
  cap.textContent = `view=${view} p=${document.documentElement.dataset.palette}\n${groups.join("\n")}\nloose: ${document.querySelectorAll(".loose .session-row").length}`;
}
void run();
