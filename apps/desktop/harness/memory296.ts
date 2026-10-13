// Item 296 harness — see memory296.html. Fixture paths and text only.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import { mount, flushSync } from "svelte";
import AssistantMessage from "../src/lib/AssistantMessage.svelte";
import type { Segment } from "../src/lib/state.svelte";

const struckLine = "- ~~Always mention Stuart's IP terms when discussing the paper.~~ (struck 2026-10-04)";
(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  invoke: async (cmd: string) => (cmd === "memory_strike" ? struckLine : cmd === "named_files" ? [] : null),
  transformCallback: () => 0,
};
const q = new URLSearchParams(location.search);
document.documentElement.dataset.palette = q.get("p") ?? "A";
const root = document.getElementById("root")!;
const cap = document.getElementById("cap")!;
root.style.width = `${q.get("w") ?? "760"}px`;

const H = "/Users/demo";
const result = `5 places in memory match "Stuart IP terms" (also searched: intellectual property; licensing conditions); searched User memory (2 files), Project instructions (1 file), Claude Code memory (2 files), Thread (3 files), Project memory (4 files), Project notes (9 files), Knowledge vault (31 files).
In your reply, name each place you mean as its path:line exactly as written below. The user sees every hit as a link that opens the file at that line, with a Strike action; do not edit or strike memory yourself unless asked.

## User memory — loaded into every chat
${H}/.nightloom/AGENTS.md:2: - Always mention Stuart's IP terms when discussing the paper.

## Project instructions — loaded into every chat
${H}/work/ace/AGENTS.md:14: Licensing conditions from Stuart apply to every release.

## Thread — loaded into every chat (chats bound to this thread)
${H}/work/ace/.agents/threads/ace/thread.md:6: The IP terms matter for ACE: check them before any write-up.

## Project memory — read on demand
${H}/work/ace/.agents/memory/stuart.md:3: Stuart's intellectual property terms: shared rights on the code.

## Knowledge vault — read on demand
${H}/.nightloom/knowledge/people/stuart.md:9: Stuart — advisor. IP terms negotiated in May.
`;
const segs = [
  {
    kind: "tool",
    call: {
      id: "t1",
      name: "mcp__nightloom__memory_where",
      input: { query: "Stuart IP terms", synonyms: ["intellectual property", "licensing conditions"], thread: "ace" },
      result: { content: result, is_error: false },
    },
  },
  {
    kind: "text",
    text:
      "Two places load into every chat, which is why it keeps coming up:\n\n" +
      `- \`~/.nightloom/AGENTS.md:2\` — your user memory tells every model to mention the terms.\n` +
      `- \`ace/AGENTS.md:14\` — the project's instructions say they apply to every release.\n\n` +
      "The thread's Start here (`threads/ace/thread.md:6`) loads too, in chats bound to it. The other two are read only when a task opens them. Strike the first to stop the reminders.",
  },
] as unknown as Segment[];

mount(AssistantMessage, {
  target: root,
  props: { segs, footer: { model: "opus", usage: { input_tokens: 41000, output_tokens: 320 }, stop_reason: "end_turn" } as never },
});
flushSync();
setTimeout(() => {
  if (q.get("strike") === "1") document.querySelector<HTMLButtonElement>(".mem .strike")?.click();
  setTimeout(() => {
    const refs = document.querySelectorAll(".mem-ref").length;
    const rows = document.querySelectorAll(".mem-row").length;
    cap.textContent = `p ${q.get("p") ?? "A"} · ${rows} hit rows · ${refs} linked references in the reply · width ${root.style.width}`;
  }, 200);
}, 300);
