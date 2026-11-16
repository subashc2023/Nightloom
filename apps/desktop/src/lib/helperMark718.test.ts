// Item 718: a trace row marks a new helper (Agent) and a continued one (SendMessage), Jarvis and Classic.
import { afterEach, describe, expect, it } from "vitest";
import { render } from "svelte/server";
import AssistantMessage from "./AssistantMessage.svelte";
import AssistantMessageClassic from "./AssistantMessageClassic.svelte";
import { app, type Segment, type SubagentRow } from "./state.svelte";
import { forgetEarlier, helperMark, sendTarget, targetRow } from "./helperMark";

const row = (o: Partial<SubagentRow>): SubagentRow =>
  ({ tool_use_id: "toolu_a", task_id: "a393aa", subagent_type: "reusable", description: "Survey the cache logs", prompt: "", status: "completed", background: false, model: "claude-opus-5-5", tokens: 84_000, tool_uses: 12, duration_ms: 1, usage: {}, rounds: 3, session: "s1", turn: 1, startedAt: 0, updatedAt: 0, segments: [], ...o }) as SubagentRow;
const agent = { id: "toolu_a", name: "Agent", input: { description: "Survey the cache logs", prompt: "x", subagent_type: "reusable" } };
const send = (id: string, to: string) => ({ id, name: "SendMessage", input: { to, message: "Now the 5-minute ones." } });

afterEach(() => {
  forgetEarlier();
  app.subagents = [];
  app.activeSessionId = null;
});

describe("the mark (718)", () => {
  it("an Agent call is a new helper; any other call but SendMessage has no mark", () => {
    expect(helperMark(agent, [], "s1", true)?.kind).toBe("new");
    expect(helperMark({ id: "b", name: "Bash", input: { command: "ls" } }, [], "s1", true)).toBeNull();
  });

  it("a SendMessage names its helper and the size it had before the message, kept as the resume grows it", () => {
    const rows = [row({})];
    const m = helperMark(send("toolu_s", "a393aa"), rows, "s1", true)!;
    expect(m.kind).toBe("continued");
    expect(m.title).toContain("“Survey the cache logs” (reusable, opus 5.5)");
    expect(m.title).toContain("It held 84k, 12 calls before this message.");
    expect(m.title).toContain("It had finished");
    // The resumed run reports a bigger helper; the earlier size stays.
    const later = helperMark(send("toolu_s", "a393aa"), [row({ tokens: 120_000, status: "running" })], "s1", true)!;
    expect(later.title).toContain("It held 84k, 12 calls before this message.");
  });

  it("a message to a running helper says it lands at its next tool round", () => {
    expect(helperMark(send("toolu_r", "a393aa"), [row({ status: "running" })], "s1", true)!.title).toContain("still running");
  });

  it("a reply from the log says the size now, and that the earlier one was not recorded", () => {
    const m = helperMark(send("toolu_l", "a393aa"), [row({ tokens: 120_000 })], "s1", false)!;
    expect(m.title).toContain("Its size before this message was not recorded; now 120k, 12 calls.");
    expect(m.title).not.toContain("had finished");
  });

  it("finds the helper by agent id, else by its name; another chat's is not it", () => {
    expect(sendTarget({ recipient: " a1 " })).toBe("a1");
    expect(sendTarget({})).toBeNull();
    const rows = [row({}), row({ task_id: "b2", description: "Second" })];
    expect(targetRow(rows, "s1", "b2")?.description).toBe("Second");
    expect(targetRow(rows, "s1", "Survey the cache logs")?.task_id).toBe("a393aa");
    expect(targetRow(rows, "s2", "a393aa")).toBeNull();
    expect(helperMark(send("toolu_x", "zzz"), rows, "s1", true)!.title).toContain("this chat has no row for it");
  });
});

describe("the rows (718)", () => {
  for (const [name, C] of [["Jarvis", AssistantMessage], ["Classic", AssistantMessageClassic]] as const) {
    it(`draws new on the Agent row and continued on the SendMessage row in ${name}`, () => {
      app.activeSessionId = "s1";
      app.subagents = [row({})];
      const segs = [
        { kind: "tool", call: { ...agent, result: { content: "done", is_error: false } } },
        { kind: "tool", call: { ...send("toolu_s2", "a393aa"), result: null } },
      ] as Segment[];
      const { body } = render(C as typeof AssistantMessage, { props: { segs, streaming: true, headed: false, since: Date.now(), motion: "combo" } });
      const marks = [...body.matchAll(/data-testid="helper-mark" data-kind="(\w+)"/g)].map((m) => m[1]);
      expect(marks).toEqual(["new", "continued"]);
      expect(body).toContain("↻");
    });
  }
});
