// Backlog 357 harness — see still357.html.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import { mount, flushSync } from "svelte";
import StillRunningLine from "../src/lib/StillRunningLine.svelte";
import RunningTasks from "../src/lib/RunningTasks.svelte";
import { app } from "../src/lib/state.svelte";
import { openTasksOn } from "../src/lib/tasksFocus.svelte";
import type { StillRunningSegment } from "../src/lib/stillRunning";

(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async () => null,
  transformCallback: () => 0,
};
const q = new URLSearchParams(location.search);
document.documentElement.dataset.palette = q.get("p") ?? "A";
const root = document.getElementById("root")!;
app.activeSessionId = "chat-a";
const row = (id: string, description: string, status: string) =>
  ({
    tool_use_id: id, task_id: id, subagent_type: "general-purpose", description, prompt: description, status,
    background: false, tokens: 83_000, tool_uses: 14, duration_ms: 0, usage: { input_tokens: 0, output_tokens: 0 },
    rounds: 3, session: "chat-a", turn: 1, startedAt: Date.now() - 125_000, updatedAt: Date.now(), segments: [],
  }) as unknown as (typeof app.subagents)[number];
app.subagents = [
  row("a", "Research a16z speedrun and Fareed Mosavat", "running"),
  row("b", "Survey AI safety grants", "completed"),
  row("c", "Find Tailwind's application terms", "running"),
  row("d", "Check the Nov 1 deadline", "stopped"),
];
const S = (tasks: string[], ids: string[], over: Partial<StillRunningSegment> = {}): StillRunningSegment => ({
  kind: "still_running", tasks, ids, turn: "t", ...over,
});
root.innerHTML = `<div id="col" style="max-width:760px;margin:0 auto;padding:28px 20px;display:flex;flex-direction:column;gap:22px;width:100%;color:var(--ink);font:16px/1.55 var(--sans)"></div>`;
const col = document.getElementById("col")!;
const add = (html: string) => { const d = document.createElement("div"); d.innerHTML = html; col.appendChild(d); return d; };
add(`<p style="margin:0">I'll send the full brief when the agent finishes.</p>`);
mount(StillRunningLine, { target: add(""), props: { seg: S(["Research a16z speedrun and Fareed Mosavat"], ["a"]) } });
mount(StillRunningLine, { target: add(""), props: { seg: S(["Research a16z speedrun and Fareed Mosavat", "Find Tailwind's application terms", "Survey AI safety grants"], ["a", "c", "b"]) } });
mount(StillRunningLine, { target: add(""), props: { seg: S(["Survey AI safety grants"], ["b"]) } });
mount(StillRunningLine, { target: add(""), props: { seg: S(["Check the Nov 1 deadline"], ["d"]) } });
if (q.get("panel") === "1") {
  openTasksOn("c");
  const p = add("");
  p.style.cssText = "border:1px solid var(--line);border-radius:10px;overflow:hidden";
  mount(RunningTasks, { target: p });
}
flushSync();
