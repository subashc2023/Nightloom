import { describe, expect, it } from "vitest";
import { FirstSeen, doingOf, quitBlockers, quitLines, quoteLine, sortRuns, type RunEntry } from "./running";

/**
 * The running list's pure half (nightshift backlogs 308, 309): what a live
 * reply is doing, the order, and the lines the quit guard holds.
 */
const run = (over: Partial<RunEntry>): RunEntry => ({
  id: "x",
  kind: "turn",
  project: "a",
  where: "Alpha",
  session: "c1",
  chat: "Chat one",
  doing: "writing",
  startedAt: 1000,
  onScreen: false,
  waiting: false,
  survivesQuit: false,
  ...over,
});

describe("doingOf", () => {
  it("names the call a reply waits on, its thinking, or its writing", () => {
    expect(doingOf([])).toBe("starting");
    expect(doingOf(null)).toBe("starting");
    expect(doingOf([{ kind: "thinking", done: false }])).toBe("thinking");
    expect(doingOf([{ kind: "thinking", done: true }, { kind: "text", text: "Hi" }])).toBe("writing");
    expect(doingOf([{ kind: "text", text: "Hi" }, { kind: "tool", call: { name: "Bash", result: null } }])).toBe("running Bash");
    expect(doingOf([{ kind: "tool", call: { name: "Read", result: { content: "", is_error: false } } }])).toBe("read Read's result");
    // A notice says nothing about what runs: the segment before it does.
    expect(doingOf([{ kind: "text", text: "Hi" }, { kind: "notice" }])).toBe("writing");
  });
});

describe("the quit's lines", () => {
  it("are what a quit would stop, oldest first, and leave out a detached Nightshift run", () => {
    const runs = [
      run({ id: "b", startedAt: 2000, chat: "Two", kind: "subagent", doing: "Survey — running Bash" }),
      run({ id: "a", startedAt: 1000 }),
      run({ id: "n", kind: "nightshift", where: "Gamma", chat: "", session: null, survivesQuit: true }),
    ];
    expect(quitBlockers(runs).map((r) => r.id)).toEqual(["b", "a"]);
    expect(quitLines(runs)).toEqual(["Alpha · Chat one · turn", "Alpha · Two · subagent"]);
  });

  it("do not move while a run only changes what it is doing", () => {
    expect(quitLines([run({ doing: "thinking" })])).toEqual(quitLines([run({ doing: "running Bash" })]));
  });

  it("are empty when nothing runs", () => {
    expect(quitLines([])).toEqual([]);
  });
});

describe("sortRuns", () => {
  it("puts the oldest first and an unknown start last", () => {
    const out = sortRuns([run({ id: "u", startedAt: null }), run({ id: "new", startedAt: 5 }), run({ id: "old", startedAt: 1 })]);
    expect(out.map((r) => r.id)).toEqual(["old", "new", "u"]);
  });
});

describe("quoteLine", () => {
  it("quotes a question on one line and cuts it", () => {
    expect(quoteLine("why\n  this?")).toBe("“why this?”");
    expect(quoteLine("x".repeat(80), 10)).toBe(`“${"x".repeat(9)}…”`);
  });
});

describe("FirstSeen", () => {
  it("keeps the clock of the first sighting until it is seen stopped", () => {
    const f = new FirstSeen();
    expect(f.mark("dream", true, 100)).toBe(100);
    expect(f.mark("dream", true, 500)).toBe(100);
    expect(f.mark("dream", false, 600)).toBeNull();
    expect(f.mark("dream", true, 700)).toBe(700);
  });
});
