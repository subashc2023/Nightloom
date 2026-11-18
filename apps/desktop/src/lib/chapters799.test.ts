import { beforeEach, describe, expect, it } from "vitest";
import { chaptersOf, commitTitle, currentChapter, placeChapters } from "./chapters";
import { editsFor, renameChapter, resetChapterEdits, setChapterRemoved, withEdits } from "./chapterEdits.svelte";
import { liveFlags } from "./state.svelte";
import type { SessionEvent } from "./types";

const at = "2026-11-18T12:00:00Z";
const user = (text: string): SessionEvent => ({ event: "user_message", text, at });
const reply = (blocks: unknown[]): SessionEvent =>
  ({ event: "assistant_message", model: "m", blocks, stop_reason: null, usage: {}, at }) as unknown as SessionEvent;
const call = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });
const result = (id: string, name: string, content: string, is_error = false): SessionEvent => ({
  event: "tool_result",
  tool_use_id: id,
  name,
  content,
  is_error,
  at,
});

function chat(): SessionEvent[] {
  return [
    { event: "session_created", id: "c", at }, // 0
    user("# Build chapters\nplease"), // 1
    reply([call("p1", "ExitPlanMode", { plan: "## The plan\n- do it" })]), // 2
    result("p1", "ExitPlanMode", "User approved the plan"), // 3
    reply([call("a1", "Agent", { description: "wave A" }), call("a2", "Agent", { description: "wave B" })]), // 4
    result("a1", "Agent", "done"), // 5
    result("a2", "Agent", "done"), // 6
    reply([call("b1", "Bash", { command: "git commit -m x" })]), // 7
    result("b1", "Bash", "[fix-799 abc1234] 799: chapters\n 3 files changed"), // 8
    reply([call("b2", "Bash", { command: "git commit -m y" })]), // 9
    result("b2", "Bash", "[fix-799 def5678] 799: tests"), // 10
    reply([{ type: "text", text: "Done." }]), // 11
    user("thanks"), // 12
  ];
}

describe("chaptersOf (item 799)", () => {
  it("reads each mark code can see, in reading order", () => {
    const evs = chat();
    const cs = chaptersOf(evs, liveFlags(evs));
    expect(cs.map((c) => [c.kind, c.key, c.anchor, c.drawn])).toEqual([
      ["start", "start", 1, false],
      ["plan", "plan:2", 3, true],
      ["wave", "wave:4", 4, true],
      ["commit", "commit:9", 10, true],
    ]);
    expect(cs[0].title).toBe("Build chapters");
    expect(cs[1].title).toBe("Plan approved: The plan");
    expect(cs[2].title).toBe("2 helpers: wave A, wave B");
    expect(cs[3].title).toBe("Committed 799: tests · +1 more");
  });

  it("drops a refused plan, a failed commit and a lone helper", () => {
    const evs: SessionEvent[] = [
      user("go"),
      reply([call("p", "ExitPlanMode", { plan: "x" })]),
      result("p", "ExitPlanMode", "User rejected", true),
      reply([call("a", "Agent", { description: "one" })]),
      result("a", "Agent", "ok"),
      reply([call("b", "Bash", { command: "git commit" })]),
      result("b", "Bash", "nothing to commit", false),
    ];
    expect(chaptersOf(evs, liveFlags(evs)).map((c) => c.kind)).toEqual(["start"]);
  });

  it("lists a hand-off without drawing it twice", () => {
    const evs: SessionEvent[] = [user("a"), { event: "hand_off", brief: "b", context: 9, reason: "soft", at }, user("b")];
    const cs = chaptersOf(evs, liveFlags(evs));
    expect(cs.map((c) => [c.kind, c.anchor, c.drawn])).toEqual([
      ["start", 0, false],
      ["hand_off", 2, false],
    ]);
  });

  it("a rewound mark drops out and an un-rewind brings it back", () => {
    const evs = chat();
    const rewound = [...evs, { event: "rewind", to: 4, at } as SessionEvent];
    expect(chaptersOf(rewound, liveFlags(rewound)).map((c) => c.kind)).toEqual(["start", "plan"]);
    const lifted = [...rewound, { event: "unrewind", of: rewound.length - 1, at } as SessionEvent];
    expect(chaptersOf(lifted, liveFlags(lifted)).map((c) => c.kind)).toEqual(["start", "plan", "wave", "commit"]);
  });

  it("commit titles count the rest", () => {
    expect(commitTitle(["a"])).toBe("Committed a");
    expect(commitTitle(["a", "b", "c"])).toBe("Committed c · +2 more");
  });
});

describe("placeChapters", () => {
  it("puts each drawn chapter before the first item at its anchor, the rest at the tail", () => {
    const evs = chat();
    const cs = chaptersOf(evs, liveFlags(evs));
    const items = [1, 2, 4, 7, 9, 11].map((index) => ({ index }));
    const p = placeChapters(items, cs);
    expect(p.before.get(2)?.map((c) => c.key)).toEqual(["plan:2", "wave:4"]);
    expect(p.before.get(5)?.map((c) => c.key)).toEqual(["commit:9"]);
    expect(p.tail).toEqual([]);
    const short = placeChapters([1, 2].map((index) => ({ index })), cs);
    expect(short.tail.map((c) => c.key)).toEqual(["plan:2", "wave:4", "commit:9"]);
  });
});

describe("currentChapter", () => {
  it("is the last place at or above the view's top", () => {
    expect(currentChapter([-Infinity, 100, 500], 300)).toBe(1);
    expect(currentChapter([200, 500], 100)).toBe(null);
  });
});

describe("chapterEdits", () => {
  beforeEach(() => {
    localStorage.clear();
    resetChapterEdits({});
  });

  it("renames, resets and removes, kept across a reload", () => {
    const c = { key: "plan:2", title: "Plan approved" };
    renameChapter("chat1", c, "  The real plan ");
    setChapterRemoved("chat1", "wave:4", true);
    resetChapterEdits(); // a reload reads localStorage
    expect(editsFor("chat1")).toEqual({ "plan:2": { title: "The real plan" }, "wave:4": { removed: true } });
    renameChapter("chat1", c, "");
    setChapterRemoved("chat1", "wave:4", false);
    expect(editsFor("chat1")).toEqual({});
  });

  it("an unchanged name is no rename", () => {
    renameChapter("chat1", { key: "start", title: "Go" }, "Go");
    expect(editsFor("chat1")).toEqual({});
  });

  it("withEdits shows his title and the removal", () => {
    const evs = chat();
    renameChapter("c", { key: "commit:9", title: "x" }, "Shipped");
    setChapterRemoved("c", "wave:4", true);
    const shown = withEdits(chaptersOf(evs, liveFlags(evs)), editsFor("c"));
    expect(shown.find((c) => c.key === "commit:9")).toMatchObject({ shown: "Shipped", renamed: true, removed: false });
    expect(shown.find((c) => c.key === "wave:4")?.removed).toBe(true);
  });
});
