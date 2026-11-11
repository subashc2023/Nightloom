// Item 589: the running step's kind and the "Thinking motion" setting.
import { describe, expect, it } from "vitest";
import { STEP_MOTIONS, parseStepMotion, toolKind } from "./stepMotion.svelte";

describe("toolKind", () => {
  it("names a command, a helper, a file, the web and the rest", () => {
    expect(toolKind("Bash")).toBe("shell");
    expect(toolKind("BashOutput")).toBe("shell");
    expect(toolKind("Agent")).toBe("agent");
    expect(toolKind("Task")).toBe("agent");
    for (const n of ["Read", "Edit", "MultiEdit", "Write", "Glob", "Grep", "NotebookEdit"]) expect(toolKind(n)).toBe("file");
    expect(toolKind("WebFetch")).toBe("web");
    expect(toolKind("WebSearch")).toBe("web");
    expect(toolKind("mcp__Claude_Browser__navigate")).toBe("web");
    expect(toolKind("TodoWrite")).toBe("other");
    expect(toolKind("AskUserQuestion")).toBe("other");
  });
});

describe("the setting", () => {
  it("offers Sweep first, and reads anything unknown as Sweep", () => {
    expect(STEP_MOTIONS.map((m) => m.id)).toEqual(["sweep", "weave", "quiet"]);
    expect(parseStepMotion(null)).toBe("sweep");
    expect(parseStepMotion("bogus")).toBe("sweep");
    expect(parseStepMotion("weave")).toBe("weave");
    expect(parseStepMotion("quiet")).toBe("quiet");
  });
});
