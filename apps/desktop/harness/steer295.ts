// Backlog 295 harness — see steer295.html. Fixtures only.
import "../src/app.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import { mount, flushSync, tick } from "svelte";
import SubagentView from "../src/lib/SubagentView.svelte";
import { app } from "../src/lib/state.svelte";
import { agentAsk, askSubagent } from "../src/lib/subagentAsk.svelte";

const q = new URLSearchParams(location.search);
document.documentElement.dataset.palette = q.get("p") ?? "A";
const cap = document.getElementById("cap")!;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const running = (q.get("s") ?? "running") === "running";

// The record the hook keeps (agent::steer), as the stub serves it.
const record = { queued: {} as Record<string, unknown[]>, delivered: [] as unknown[] };
const now = Date.now();
(window as unknown as { __stub: (c: string, a: Record<string, unknown>) => Promise<unknown> }).__stub = async (cmd, a) => {
  switch (cmd) {
    case "steer_subagent":
      ((record.queued[a.agentId as string] ??= []) as unknown[]).push({ id: a.id, text: a.text, at_ms: Date.now() });
      return null;
    case "steer_state":
      return record;
    case "unsteer_subagent":
      return true;
    default:
      return null;
  }
};

const call = (id: string, name: string, input: unknown, content: string) => ({
  kind: "tool" as const,
  call: { id, name, input, result: { content, is_error: false } },
});
const row = {
  tool_use_id: "toolu_spawn",
  task_id: "a14d0b3af0288824b",
  subagent_type: "general-purpose",
  description: "Survey the test folders",
  prompt: "List the test folders and say which run in CI.",
  status: running ? "running" : "completed",
  background: false,
  model: "haiku",
  tokens: 13773,
  tool_uses: 3,
  duration_ms: 8098,
  usage: {},
  rounds: 4,
  session: "chat-a",
  turn: 1,
  startedAt: now - 60_000,
  updatedAt: now,
  segments: [
    { kind: "text", text: "I'll start with the folder layout." },
    call("toolu_r1", "Glob", { pattern: "**/*.test.ts" }, "src/lib/a.test.ts\nsrc/lib/b.test.ts\ne2e/flow.test.ts"),
    call("toolu_r2", "Read", { file_path: "/w/package.json" }, '{ "scripts": { "test": "vitest run" } }'),
    { kind: "text", text: "Skipping e2e as asked; checking the CI file next." },
    call("toolu_r3", "Read", { file_path: "/w/.github/workflows/ci.yml" }, "jobs:\n  test:\n    run: npm test"),
  ],
};
app.subagents = [row as never];
app.activeSessionId = "chat-a";
app.busy = running;
app.connection = { engine: "claude-code", workspace: "/w", folders: [], model: "opus" } as unknown as typeof app.connection;
agentAsk.steered = {
  toolu_spawn: [
    {
      id: "n1",
      text: "Skip the e2e folder — it never runs in CI.",
      at: new Date(now - 40_000).toISOString(),
      session: "chat-a",
      agentId: row.task_id,
      tellMain: true,
      deliveredAt: new Date(now - 38_000).toISOString(),
      tool: "Read",
      toolUseId: "toolu_r2",
    },
  ],
};
agentAsk.notes = {};
agentAsk.tellMain = true;

mount(SubagentView, { target: document.getElementById("root")!, props: { content: { kind: "subagent", session: "chat-a", toolUseId: "toolu_spawn", name: "x" } } });
flushSync();
if (running) {
  // His second note, sent through the real path: queued, not yet reached.
  agentAsk.drafts.toolu_spawn = "Also say which ones are slow.";
  const r = app.subagents[0];
  await askSubagent(r, "Also say which ones are slow.");
  agentAsk.drafts.toolu_spawn = "";
}
await tick();
await wait(150);
const lines: string[] = [];
lines.push(`hint: "${document.querySelector(".hint")?.textContent?.trim().replace(/\s+/g, " ")}"`);
lines.push(`delivered inline after a call: ${document.querySelectorAll(".segs .arrived").length} · "${document.querySelector(".segs .arrived-label")?.textContent}"`);
lines.push(`on its way: ${Array.from(document.querySelectorAll(".talk .held")).map((e) => e.textContent?.trim().replace(/\s+/g, " ")).join(" | ")}`);
lines.push(`queued in the stub: ${JSON.stringify(record.queued)} · button "${document.querySelector(".send")?.textContent?.trim()}" · box placeholder "${document.querySelector("textarea.ask")?.getAttribute("placeholder")}"`);
cap.textContent = lines.join("\n");
