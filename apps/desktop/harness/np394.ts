// Item 394 — the New project tab survives project switches, chat opens and a relaunch. The real App over a
// stubbed backend (from app360.ts). Phase 1: open the form, type in its fields as keystrokes would (input events on
// the real inputs), switch project twice, open two chats with plain clicks' path; then reload as ?phase=2 — the
// relaunch, localStorage kept — and read the strip, then click the New project tab and read its fields.
// ?hide=1 hides the log at the end, for a clean shot of the form.
import "@fontsource-variable/newsreader/wght.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "katex/dist/katex.min.css";
import "../src/app.css";
import { mount, flushSync, tick } from "svelte";
import App from "../src/App.svelte";
import { activateTab, app, flushNewProject, flushTabs, openSession, showNewProject, useProject } from "../src/lib/state.svelte";
import * as tabs from "../src/lib/tabs";

const q = new URLSearchParams(location.search);
const phase = q.get("phase") === "2" ? 2 : 1;
const cap = document.getElementById("cap")!;
cap.classList.add("on");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
document.head.insertAdjacentHTML("beforeend", "<style>*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important} .toasts{display:none!important}</style>");

const mk = (id: string, name: string) => ({ id, name, root: `/Users/you/${id}`, notes_dir: `/Users/you/${id}/n`, chats: 2, notes: 0, exists: true });
const projects = [mk("p46", "ICS 46"), mk("p61", "Thesis")];
const sessions = [
  { id: "s1", title: "Why the AVL tree rotates twice", mode: "normal", kind: "build", modified: ago(3) },
  { id: "s2", title: "Lab 4 — cache simulator", mode: "normal", kind: "build", modified: ago(200) },
];
const at = ago(40);
(window as unknown as { __stub: (c: string, a?: Record<string, unknown>) => Promise<unknown> }).__stub = async (cmd, args) => {
  switch (cmd) {
    case "list_projects":
      return projects;
    case "open_project":
      return projects.find((p) => p.id === args?.id) ?? projects[0];
    case "list_sessions":
      return sessions;
    case "new_session":
      return { mode: "normal", kind: "build" };
    case "open_session":
      return [
        { event: "user_message", text: "a question", at },
        { event: "assistant_message", model: "claude-opus-5-5", blocks: [{ type: "text", text: "an answer" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, at },
      ];
    case "resolve_new_project_path":
      return { path: "/Users/you/projects/half-typed", exists: false, slug: "half-typed" };
    case "providers":
      return [{ kind: "anthropic", available: true, default_model: "claude-opus-5-5", key_source: "stored" }];
    case "list_models":
      return ["claude-opus-5-5"];
    case "list_notes":
    case "turn_usage":
    case "list_threads":
    case "nightshift_projects":
    case "centre_proposals":
    case "centre_dream_commits":
    case "search_backends":
    case "for_you_files":
    case "list_proposals":
    case "web_labels":
    case "centre_applied":
    case "model_list_get":
      return [];
    default:
      return null;
  }
};
document.documentElement.dataset.palette = "B";
mount(App, { target: document.getElementById("app")! });
flushSync();

const log: string[] = [];
const strip = () =>
  app.tabs.panes
    .map((p) => p.tabs.map((t) => (t.id === p.active ? "*" : "") + tabs.tabTitle(t.content, app.sessions, app.projects)).join(" | "))
    .join("  ||  ");
const fields = () => {
  const n = document.querySelector<HTMLInputElement>('input[aria-label="Project name"]');
  const i = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Project instructions"]');
  return `name=${JSON.stringify(n?.value ?? null)} instructions=${JSON.stringify(i?.value ?? null)}`;
};
const type = (el: HTMLInputElement | HTMLTextAreaElement | null, text: string) => {
  if (!el) throw new Error("field not found");
  for (const ch of text) {
    el.value += ch;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
};
const domTabs = () =>
  [...document.querySelectorAll(".tab-strip")]
    .map((st) => [...st.querySelectorAll(".tab")].map((e) => (e.textContent ?? "").trim().slice(0, 24)).join(" | "))
    .join(" // ");
const say = (s: string) => {
  s += `  [DOM: ${domTabs()}]${app.error ? " app.error=" + app.error : ""}`;
  log.push(s);
  cap.textContent = log.join("\n");
};

window.addEventListener("error", (e) => say("window error: " + e.message.split("\n")[0]));
window.addEventListener("unhandledrejection", (e) => say("rejection: " + String(e.reason)));
const errs0 = cap.textContent ?? "";
if (errs0.trim()) log.push("before harness: " + errs0.trim().slice(0, 300));

async function until(ok: () => boolean, ms = 3000) {
  for (let t = 0; t < ms && !ok(); t += 50) await wait(50);
}

async function phase1() {
  await wait(1500);
  say(`phase 1, launch: project=${app.project?.name ?? "none"} strip: ${strip()}`);
  await useProject("p46");
  await openSession("s1");
  await tick();
  say(`in ICS 46 with a chat: ${strip()}`);
  showNewProject();
  await tick();
  flushSync();
  say(`after showNewProject: view=${app.view} ${strip()}`);
  type(document.querySelector('input[aria-label="Project name"]'), "Half typed");
  type(document.querySelector('textarea[aria-label="Project instructions"]'), "Keep answers short.");
  await tick();
  say(`form open, typed: ${strip()} — ${fields()}`);
  await useProject("p61");
  await tick();
  say(`switch 1 → ${app.project?.name}: view=${app.view} ${strip()} — ${fields()}`);
  await useProject("p46");
  await tick();
  say(`switch 2 → ${app.project?.name}: view=${app.view} ${strip()}`);
  // Two chats, each the way a sidebar row's plain click opens one (the reflection lands it, "replace").
  await openSession("s1");
  await tick();
  say(`chat 1 opened: ${strip()}`);
  await openSession("s2");
  await tick();
  say(`chat 2 opened: ${strip()}`);
  flushTabs();
  flushNewProject();
  say(`stored nightloom.newProject: ${localStorage.getItem("nightloom.newProject")}`);
  sessionStorage.setItem("np394.log", log.join("\n"));
  location.search = "?phase=2" + (q.get("hide") === "1" ? "&hide=1" : "");
}

async function phase2() {
  log.push(...(sessionStorage.getItem("np394.log") ?? "").split("\n"));
  await wait(1500);
  say(`--- relaunch: project=${app.project?.name ?? "none"} view=${app.view} ${strip()}`);
  const np = tabs.findAnywhere(app.tabs, { kind: "new-project" });
  if (np) await activateTab(np.id);
  await tick();
  flushSync();
  say(`New project tab clicked: view=${app.view} ${strip()} — ${fields()}`);
  document.title = "np394 done";
  if (q.get("hide") === "1") cap.classList.remove("on");
}

void (phase === 1 ? phase1() : phase2()).catch((e) => say("error: " + String(e)));
