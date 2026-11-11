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
  it("offers Combo (the default), Sweep and Reticle, and reads anything unknown as Combo (item 616)", () => {
    expect(STEP_MOTIONS.map((m) => m.id)).toEqual(["combo", "sweep", "reticle"]);
    expect(STEP_MOTIONS.map((m) => m.name)).toEqual(["Combo", "Sweep — today's", "Reticle"]);
    expect(parseStepMotion(null)).toBe("combo");
    expect(parseStepMotion("bogus")).toBe("combo");
    expect(parseStepMotion("sweep")).toBe("sweep");
    expect(parseStepMotion("reticle")).toBe("reticle");
  });

  it("reads a saved Weave or Quiet (gone since 616) as Combo", () => {
    expect(parseStepMotion("weave")).toBe("combo");
    expect(parseStepMotion("quiet")).toBe("combo");
  });
});
