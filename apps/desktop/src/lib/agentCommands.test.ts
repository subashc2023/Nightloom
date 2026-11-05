import { describe, expect, it } from "vitest";
import { commandsOf, commandsText, isShellCall, runningOf } from "./agentCommands";
import type { Segment } from "./state.svelte";
import type { SessionEvent } from "./types";

const at = "2026-11-04T00:00:00Z";
function reply(...blocks: unknown[]): SessionEvent {
  return { event: "assistant_message", blocks, model: "m", usage: {}, stop_reason: null, at } as unknown as SessionEvent;
}
const use = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const result = (id: string, content: string, is_error = false): SessionEvent => ({
  event: "tool_result",
  tool_use_id: id,
  name: "Bash",
  content,
  is_error,
  at,
});

describe("503: a chat's recorded commands", () => {
  it("takes both engines' shell tools, in call order, and nothing else", () => {
    const rows = commandsOf([
      reply(use("a", "Bash", { command: "git status" }), use("r", "Read", { file_path: "x" })),
      result("a", "clean"),
      reply(use("b", "bash", { command: "ls" })),
      result("b", "x\ny"),
    ]);
    expect(rows.map((r) => r.command)).toEqual(["git status", "ls"]);
    expect(rows.map((r) => r.output)).toEqual(["clean", "x\ny"]);
  });
  it("marks an error", () => {
    const text = commandsText(commandsOf([reply(use("a", "Bash", { command: "false" })), result("a", "boom", true)]), false);
    expect(text).toContain("boom");
    expect(text).toContain("✗ failed");
  });
  it("labels a recorded subagent's, from its narrative", () => {
    const block = `<subagent parent="p">\n▸ Bash npm test · Run the tests\n  ↳ error: 3 failed\n▸ Read x\n  ↳ y\n</subagent>`;
    const rows = commandsOf([reply(use("p", "Agent", { subagent_type: "Explore" })), reply({ type: "text", text: block })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ command: "npm test", agent: "Explore", output: "3 failed", error: true });
    expect(commandsText(rows, false)).toContain("first line only");
  });
  it("labels a live subagent's, from its segments", () => {
    const live: Segment[] = [
      {
        kind: "tool",
        call: {
          id: "p",
          name: "Agent",
          input: { description: "tests" },
          result: null,
          children: [{ kind: "tool", call: { id: "c", name: "Bash", input: { command: "ls" }, result: { content: "x", is_error: false } } }],
        },
      },
    ];
    expect(commandsOf([], live)[0]).toMatchObject({ command: "ls", agent: "tests" });
  });
  it("puts a background command's later output under it when the id links them", () => {
    const rows = commandsOf([
      reply(use("a", "Bash", { command: "npm run dev", run_in_background: true })),
      result("a", "Command running in background with ID: bash_1"),
      reply(use("o", "BashOutput", { bash_id: "bash_1" })),
      result("o", "listening"),
      reply(use("l", "Bash", { command: "curl x" })),
      result("l", "ok"),
    ]);
    expect(rows.map((r) => r.command)).toEqual(["npm run dev", "curl x"]);
    expect(rows[0].later).toEqual([{ output: "listening", error: false }]);
    const text = commandsText(rows, false);
    expect(text.indexOf("listening")).toBeLessThan(text.indexOf("curl x"));
  });
  it("shows an output call with no link as its own row", () => {
    const rows = commandsOf([reply(use("o", "TaskOutput", { task_id: "zz" })), result("o", "text")]);
    expect(rows[0].command).toBe("(TaskOutput zz)");
  });
  it("offers the way in on shell calls only", () => {
    expect(isShellCall("Bash")).toBe(true);
    expect(isShellCall("bash")).toBe(true);
    expect(isShellCall("TaskOutput")).toBe(true);
    expect(isShellCall("Read")).toBe(false);
  });
});

describe("503: following a running turn", () => {
  const events = [reply(use("a", "Bash", { command: "one" })), result("a", "1")];
  const running: Segment = { kind: "tool", call: { id: "b", name: "Bash", input: { command: "two" }, result: null } };
  const done: Segment = { kind: "tool", call: { id: "b", name: "Bash", input: { command: "two" }, result: { content: "2", is_error: false } } };
  it("keeps a running command out of the grid and says it runs", () => {
    const rows = commandsOf(events, [running]);
    expect(runningOf(rows).map((r) => r.command)).toEqual(["two"]);
    expect(commandsText(rows, true)).not.toContain("two");
  });
  it("only appends, so a selection and the scroll stay", () => {
    const before = commandsText(commandsOf(events, [running]), true);
    const after = commandsText(commandsOf(events, [done]), true);
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain("two");
  });
  it("holds a later call until the earlier has ended: call order", () => {
    const later: Segment = { kind: "tool", call: { id: "c", name: "Bash", input: { command: "three" }, result: { content: "3", is_error: false } } };
    const text = commandsText(commandsOf(events, [running, later]), true);
    expect(text).not.toContain("three");
  });
  it("says so when a run ended with a call open", () => {
    expect(commandsText(commandsOf(events, [running]), false)).toContain("no result recorded");
  });
  it("does not double a call the log and the live turn both hold", () => {
    expect(commandsOf([...events], [{ kind: "tool", call: { id: "a", name: "Bash", input: { command: "one" }, result: null } }])).toHaveLength(1);
  });
  it("strips escapes from what is shown", () => {
    const rows = commandsOf([reply(use("a", "Bash", { command: "x" })), result("a", "\x1b[2Jplain")]);
    expect(commandsText(rows, false)).toContain("plain");
    expect(commandsText(rows, false)).not.toContain("[2J");
  });
});
