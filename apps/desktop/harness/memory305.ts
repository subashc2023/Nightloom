// Item 305 harness — see memory305.html. Fixture paths and text only.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import { mount, flushSync } from "svelte";
import AssistantMessage from "../src/lib/AssistantMessage.svelte";
import { app } from "../src/lib/state.svelte";
import type { Segment } from "../src/lib/state.svelte";

const NOTE = "# Course progress\n\n- Week 1: done\n- Week 2: done\n- Week 3: quiz on Friday\n";
const calls: string[] = [];
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    calls.push(cmd);
    if (cmd === "memory_note_for") return ["project", "memory/course-progress.md"];
    if (cmd === "read_note") return NOTE;
    if (cmd === "named_files") return [];
    void args;
    return null;
  },
  transformCallback: () => 0,
};
const q = new URLSearchParams(location.search);
document.documentElement.dataset.palette = q.get("p") ?? "A";
const root = document.getElementById("root")!;
const cap = document.getElementById("cap")!;
root.style.width = `${q.get("w") ?? "760"}px`;

const P = "/Users/demo/work/course";
const ok = (content: string) => ({ content, is_error: false });
const segs = [
  { kind: "thinking", text: "Record week 3.", done: true },
  {
    kind: "tool",
    call: { id: "t1", name: "Read", input: { file_path: `${P}/.agents/memory/course-progress.md` }, result: ok(NOTE) },
  },
  {
    kind: "tool",
    call: {
      id: "t2",
      name: "Edit",
      input: { file_path: `${P}/.agents/memory/course-progress.md`, old_string: "- Week 2: done\n", new_string: "- Week 2: done\n- Week 3: quiz on Friday\n" },
      result: ok(`The file ${P}/.agents/memory/course-progress.md has been updated successfully.`),
    },
  },
  {
    kind: "tool",
    call: { id: "t3", name: "Edit", input: { file_path: `${P}/src/main.ts`, old_string: "a", new_string: "b" }, result: ok("updated") },
  },
  { kind: "text", text: "Noted week 3 in your course progress. I'll add it to the thread's queue too." },
  {
    kind: "tool",
    call: {
      id: "t4",
      name: "edit_file",
      input: { path: ".agents/threads/stats-course/thread.md", old_string: "## Queue\n", new_string: "## Queue\n- Week 3 quiz\n" },
      result: ok("Edited .agents/threads/stats-course/thread.md"),
    },
  },
  { kind: "text", text: "Done." },
] as unknown as Segment[];

(app as unknown as { connection: unknown }).connection = { workspace: P };
mount(AssistantMessage, {
  target: root,
  props: { segs, footer: { model: "haiku", usage: { input_tokens: 9000, output_tokens: 120 }, stop_reason: "end_turn" } as never },
});
flushSync();
setTimeout(() => {
  if (q.get("click") === "1") document.querySelector<HTMLButtonElement>(".mem-edit")?.click();
  setTimeout(() => {
    const lines = [...document.querySelectorAll(".mem-edit")].map((e) => e.textContent?.trim()).join(" | ");
    const at = app.noteAt ? `noteAt ${app.noteAt.scope}:${app.noteAt.name}:${app.noteAt.line}` : "noteAt none";
    cap.textContent = `p ${q.get("p") ?? "A"} · ${document.querySelectorAll(".mem-edit").length} lines: ${lines} · ${at} · ${calls.join(",")}`;
  }, 300);
}, 300);
