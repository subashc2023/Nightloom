// Item 289 harness — see row289.html.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import { mount, flushSync } from "svelte";
import Welcome from "../src/lib/Welcome.svelte";
import Composer from "../src/lib/Composer.svelte";
import { app } from "../src/lib/state.svelte";
import { setDraftText, draftKey } from "../src/lib/drafts.svelte";

(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke: async () => null, transformCallback: () => 0 };
const q = new URLSearchParams(location.search);
document.documentElement.dataset.palette = q.get("p") ?? "A";
const root = document.getElementById("root")!;
const cap = document.getElementById("cap")!;
root.style.width = `${q.get("w") ?? "700"}px`;
app.connection = { engine: "claude-code", workspace: "/tmp" } as unknown as typeof app.connection;
app.draft.engine = "claude-code";
app.draft.agentModel = "opus";
app.draft.agentEffort = "";
const v = q.get("v") ?? "welcome";
if (v === "chat") {
  app.activeSessionId = "chat-a";
  app.events = [{ kind: "user", text: "hi" }] as unknown as typeof app.events;
}
if (q.get("busy") === "1") app.busy = true;
if (q.get("text") === "1")
  setDraftText(draftKey(app.activeSessionId, app.project?.id, app.pendingMode), "Look at the watermark rule again and tell me where the redo cost goes. ".repeat(4));
if (v === "welcome") mount(Welcome, { target: root });
else {
  root.innerHTML = `<div class="main"></div>`;
  mount(Composer, { target: root.querySelector(".main")!, props: {} });
}
flushSync();
setTimeout(() => {
  const row = document.querySelector<HTMLElement>(".composer .row");
  const card = document.querySelector<HTMLElement>(".composer .card");
  const tops = row ? [...row.children].map((c) => Math.round(c.getBoundingClientRect().top)).filter((t, i, a) => a.indexOf(t) === i) : [];
  cap.textContent = `${v} pane ${root.style.width} · card ${Math.round(card?.getBoundingClientRect().width ?? 0)} px · fold ${row?.dataset.fold} · row tops ${tops.join(",")}`;
}, 600);
