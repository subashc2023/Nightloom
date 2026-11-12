// Item 649 (his "what happened to bash showing a remnant of like the command stuff it was doing"): the passing
// text reaches every row that draws a running or just-ended shell call, and a command too short for the
// backend's first look at its spool still leaves its last lines, fading.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "svelte/server";
import AssistantMessage from "./AssistantMessage.svelte";
import type { Segment } from "./state.svelte";
import { LINGER_MS, endPassing, lastLines, passingEnded, passingEvent, passingLines, setPassing } from "./bashOutput.svelte";
import { isShellCall } from "./agentCommands";

afterEach(() => vi.useRealTimers());

const bash = (id: string, done: boolean): Segment =>
  ({ kind: "tool", call: { id, name: "Bash", input: { command: "cargo test" }, result: done ? { content: "ok", is_error: false } : null } }) as Segment;

describe("the remnant (649)", () => {
  it("keeps a shell call's last output lines for LINGER_MS after its result, then drops them", () => {
    vi.useFakeTimers();
    passingEvent({ type: "tool_result", tool_use_id: "r1", name: "Bash", content: "a\n\nb\r\x1b[32mc\x1b[0m\n" }, isShellCall);
    expect(passingLines("r1")).toEqual(["a", "c"]);
    expect(passingEnded("r1")).toBe(true);
    setPassing("r1", ["late"]); // a tick after the result never revives it
    expect(passingLines("r1")).toEqual(["a", "c"]);
    vi.advanceTimersByTime(LINGER_MS + 1);
    expect(passingLines("r1")).toEqual([]);
    expect(passingEnded("r1")).toBe(false);
  });

  it("falls back to what passed live when the result is empty; a refusal or a non-shell result leaves nothing", () => {
    vi.useFakeTimers();
    expect(passingEvent({ type: "tool_output", tool_use_id: "r2", lines: ["tick 3"] }, isShellCall)).toBe(true);
    passingEvent({ type: "tool_result", tool_use_id: "r2", name: "Bash", content: "" }, isShellCall);
    expect(passingLines("r2")).toEqual(["tick 3"]);
    setPassing("r3", ["x"]);
    passingEvent({ type: "tool_denied", tool_use_id: "r3" }, isShellCall);
    expect(passingLines("r3")).toEqual([]);
    setPassing("r4", ["x"]);
    passingEvent({ type: "tool_result", tool_use_id: "r4", name: "Read", content: "file text" }, isShellCall);
    expect(passingLines("r4")).toEqual([]);
    endPassing("r2");
  });

  it("reads output as a terminal's last lines show it, at most six", () => {
    expect(lastLines(Array.from({ length: 9 }, (_, i) => `l${i}`).join("\n"))).toEqual(["l3", "l4", "l5", "l6", "l7", "l8"]);
    expect(lastLines("50%\r100%\n")).toEqual(["100%"]);
  });
});

describe("the event reaches the row in each render path (649)", () => {
  it("a running Bash row in the chat's (or an aside's) trace", () => {
    setPassing("m1", ["Compiling nightloom-core"]);
    const { body } = render(AssistantMessage, { props: { segs: [bash("m1", false)], streaming: true, headed: false, since: Date.now(), motion: "combo" } });
    expect(body).toContain('data-testid="bash-passing"');
    expect(body).toContain("Compiling nightloom-core");
    endPassing("m1");
  });

  it("a Bash row that just ended, fading, in a live or a logged reply", () => {
    vi.useFakeTimers();
    passingEvent({ type: "tool_result", tool_use_id: "m2", name: "Bash", content: "test result: ok. 412 passed" }, isShellCall);
    for (const streaming of [true, false]) {
      const { body } = render(AssistantMessage, { props: { segs: [bash("m2", true)], streaming, headed: false, since: Date.now(), motion: "combo" } });
      expect(body).toMatch(/class="passing[^"]*ended/);
      expect(body).toContain("412 passed");
    }
  });

  it("a subagent's running Bash row", () => {
    setPassing("c1", ["running 12 tests"]);
    const agent = {
      kind: "tool",
      call: { id: "a1", name: "Agent", input: { description: "d" }, result: null, children: [bash("c1", false)] },
    } as unknown as Segment;
    const { body } = render(AssistantMessage, { props: { segs: [agent], streaming: true, headed: false, since: Date.now(), motion: "combo" } });
    expect(body).toContain("running 12 tests");
    endPassing("c1");
  });

  it("never a row that ended long ago (a reload draws no passing text)", () => {
    const { body } = render(AssistantMessage, { props: { segs: [bash("old", true)], streaming: false, headed: false, since: Date.now() } });
    expect(body).not.toContain('data-testid="bash-passing"');
  });
});
