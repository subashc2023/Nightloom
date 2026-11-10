import { describe, expect, it } from "vitest";
import { browserSteps, sameChat } from "./browserSteps";

const call = (id: string, name: string, input: unknown, result: { is_error: boolean } | null) => ({
  kind: "tool",
  call: { id, name, input, result: result ? { content: "", ...result } : null },
});

describe("browserSteps (item 567)", () => {
  it("keeps only the browser calls, in order, numbered, each with its state", () => {
    const segs = [
      { kind: "text", text: "Opening it." },
      call("a", "mcp__playwright__browser_navigate", { url: "https://staging.example.com/signup" }, { is_error: false }),
      call("b", "Read", { file_path: "x" }, { is_error: false }),
      call("c", "mcp__playwright__browser_type", { element: "the email field", text: "t@example.test" }, { is_error: true }),
      call("d", "mcp__playwright__browser_click", { element: "Create account" }, null),
    ];
    const { steps, total } = browserSteps(segs);
    expect(total).toBe(3);
    expect(steps.map((s) => [s.n, s.tool, s.target, s.state])).toEqual([
      [1, "navigate", "https://staging.example.com/signup", "done"],
      [2, "type", "the email field", "failed"],
      [3, "click", "Create account", "running"],
    ]);
  });

  it("shows the last few, numbered by their place in the whole turn", () => {
    const segs = Array.from({ length: 5 }, (_, i) => call(`p${i}`, "mcp__playwright__browser_snapshot", {}, { is_error: false }));
    const { steps, total } = browserSteps(segs, 2);
    expect(total).toBe(5);
    expect(steps.map((s) => s.n)).toEqual([4, 5]);
    expect(steps[0].target).toBeNull();
  });

  it("is empty for no turn or a turn with no browser calls", () => {
    expect(browserSteps(null)).toEqual({ steps: [], total: 0 });
    expect(browserSteps([call("a", "Bash", { command: "ls" }, null)])).toEqual({ steps: [], total: 0 });
  });

  it("a denied call reads as failed", () => {
    const s = call("a", "mcp__playwright__browser_click", { element: "x" }, { is_error: false });
    (s.call as { denied?: boolean }).denied = true;
    expect(browserSteps([s]).steps[0].state).toBe("failed");
  });
});

describe("sameChat", () => {
  it("matches an id and a turn key that starts with it, never an empty one", () => {
    expect(sameChat("s1", "s1")).toBe(true);
    expect(sameChat("abc-123", "abc")).toBe(true);
    expect(sameChat("abc", "abc-123")).toBe(false);
    expect(sameChat("abc", "xyz")).toBe(false);
    expect(sameChat(null, "s1")).toBe(false);
    expect(sameChat("", "")).toBe(false);
  });
});
