// Backlog 370 harness — see move370.html.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import { mount, flushSync, tick } from "svelte";
import Sidebar from "../src/lib/Sidebar.svelte";
import TabStrip from "../src/lib/TabStrip.svelte";
import { app } from "../src/lib/state.svelte";
import { drafts } from "../src/lib/drafts.svelte";
import * as tabs from "../src/lib/tabs";

const stage = new URLSearchParams(location.search).get("stage") ?? "after";
const cap = document.getElementById("cap")!;
const log = (s: string) => (cap.textContent += s + "\n");
const when = new Date(Date.now() - 600_000).toISOString();
const row = (id: string, title: string) => ({ id, title, mode: "normal", kind: "chat", modified: when });

// A fake store: chats by folder; the open project is "unf" (the claude.ai Unfiled chats holder).
const folders: Record<string, ReturnType<typeof row>[]> = {
  unf: [row("c1-kyoto", "Plan the trip to Kyoto"), row("c2-parsnip", "Parsnip soup")],
  ai: [row("c3-evals", "Evals reading list")],
  none: [],
};
const project = (id: string, name: string) => ({ id, name, root: null, notes_dir: "", notes: 0, chats: folders[id].length, exists: true, last_opened: when, extra_folders: [], unfiled: id === "unf" });
const calls: string[] = [];
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push(cmd);
    if (cmd === "list_sessions") return folders.unf;
    if (cmd === "list_projects") return [project("unf", "Unfiled chats"), project("ai", "AI Safety Collective")];
    if (cmd === "move_session") {
      const i = folders.unf.findIndex((r) => r.id === args.id);
      const [r] = folders.unf.splice(i, 1);
      folders[(args.to as string | null) ?? "none"].push(r);
      return r.id;
    }
    // Every other list the panels read is empty here.
    if (cmd.startsWith("list_")) return [];
    return null;
  },
  transformCallback: () => 0,
};

app.project = project("unf", "Unfiled chats") as unknown as typeof app.project;
app.projects = [project("unf", "Unfiled chats"), project("ai", "AI Safety Collective")] as unknown as typeof app.projects;
app.sessions = [...folders.unf] as unknown as typeof app.sessions;
const w = tabs.emptyWorkspace();
w.panes[0].tabs = app.sessions.map((s) => tabs.makeTab({ kind: "chat", session: s.id }));
w.panes[0].active = w.panes[0].tabs[1].id;
app.tabs = w;
drafts["c2-parsnip"] = { text: "half a thought", attachments: [], queue: [{ id: 1, text: "queued for parsnips", attachments: [] }] } as unknown as (typeof drafts)[string];
try { localStorage.removeItem("nightloom.tabs"); } catch { /* none */ }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function menuItem(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((b) => b.textContent?.trim().startsWith(label));
}

mount(Sidebar, { target: document.getElementById("side")! });
const paneEl = document.getElementById("pane")!;
paneEl.dataset.pane = app.tabs.panes[0].id;
mount(TabStrip, { target: paneEl, props: { pane: app.tabs.panes[0] } });
flushSync();

(async () => {
  const rows = () => Array.from(document.querySelectorAll(".session-row .snippet")).map((e) => e.textContent?.trim());
  log(`before: sidebar ${JSON.stringify(rows())}; tabs ${app.tabs.panes[0].tabs.length}`);
  const rowBtn = Array.from(document.querySelectorAll<HTMLElement>(".session-row")).find((e) => e.textContent?.includes("Parsnip"))!;
  rowBtn.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
  flushSync();
  menuItem("Move to project")?.click();
  flushSync();
  const targets = Array.from(document.querySelectorAll('[aria-label="Move to project"] [role="menuitem"]')).map((b) => b.textContent?.trim());
  log(`menu targets: ${JSON.stringify(targets)}`);
  if (stage === "menu") return;
  menuItem("AI Safety Collective")?.click();
  flushSync();
  await sleep(100);
  await tick();
  log(`after: sidebar ${JSON.stringify(rows())}; store unf=${folders.unf.map((r) => r.id)} ai=${folders.ai.map((r) => r.id)}`);
  log(`tabs here: ${JSON.stringify(app.tabs.panes[0].tabs.map((t) => t.content))}`);
  const stored = JSON.parse(localStorage.getItem("nightloom.tabs") ?? "{}");
  log(`stored for ai: ${JSON.stringify(stored.ai)}`);
  log(`draft c2: ${JSON.stringify(drafts["c2-parsnip"]?.text)} queue ${drafts["c2-parsnip"]?.queue.length}`);
  log(`calls: ${[...new Set(calls)].join(",")}`);
  log(`unmocked-panel errors (not the move's): ${(window as unknown as { harnessNoise: number }).harnessNoise}`);
  log(`toast: ${JSON.stringify((app as unknown as { toasts?: { text?: string; message?: string }[] }).toasts?.map((t) => t.text ?? t.message))}`);
})();
