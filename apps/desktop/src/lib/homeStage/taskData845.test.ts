// Item 845 batch 1: the task views' payloads (taskData.ts), the step words for Nightloom's own MCP tools, and the
// two stage fixes (no container queries; a view switch the stage makes itself does not animate).
import { beforeAll, describe, expect, it } from "vitest";
import { hoursOf, hourWords, rowsOf, timelineOf, todoOf, triageOf } from "./taskData";
import { toolWords } from "./steps";

describe("times", () => {
  it("reads the shapes Home writes and nothing else", () => {
    expect(hoursOf("14:30")).toBe(14.5);
    expect(hoursOf("2:30 PM")).toBe(14.5);
    expect(hoursOf("2 pm")).toBe(14);
    expect(hoursOf("12:00 am")).toBe(0);
    expect(hoursOf("2")).toBeNull();
    expect(hoursOf("25:00")).toBeNull();
    expect(hoursOf("soon")).toBeNull();
    expect(hoursOf(undefined)).toBeNull();
  });
  it("says hours in 12-hour AM/PM", () => {
    expect(hourWords(14.5)).toBe("2:30 PM");
    expect(hourWords(9)).toBe("9:00 AM");
    expect(hourWords(12)).toBe("12:00 PM");
  });
});

describe("detail rows", () => {
  it("takes an object or pairs, drops the rest, at most 8", () => {
    expect(rowsOf({ "Who asked": "Priya", n: 3, bad: {} })).toEqual([["Who asked", "Priya"], ["n", "3"]]);
    expect(rowsOf([["A", "b"], ["only"], "x"])).toEqual([["A", "b"]]);
    expect(rowsOf(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, "v"]))).length).toBe(8);
    expect(rowsOf(null)).toEqual([]);
  });
});

describe("timeline", () => {
  const data = {
    day: "Wednesday, November 18",
    date: "2026-11-18",
    events: [{ id: "lunch", title: "Lunch", start: "12:00", end: "13:00" }, { title: "No time" }, { id: "x", start: "9:00" }],
    changes: [
      { id: "review", kind: "move", title: "Design review", start: "15:30", end: "16:30", was: "14:00", why: "Priya asked" },
      { id: "priya", kind: "pick", title: "30 min with Priya", slots: ["11:30", "16:30"], minutes: 30, yours: true },
      { id: "odd", kind: "pick", title: "No slots", start: "10:00" },
      { kind: "weird", title: "Defaults to a move", start: "17:00" },
    ],
  };
  const t = timelineOf(data, "2026-11-18");
  it("keeps rows with a title and a time, ids prefixed", () => {
    expect(t.events.map((e) => e.id)).toEqual(["e:lunch"]);
    expect(t.changes.map((c) => [c.id, c.kind])).toEqual([["c:review", "move"], ["c:priya", "pick"], ["c:odd", "add"], ["c:3:Defaults to a move", "move"]]);
  });
  it("reads a move's old start, a pick's slots and length", () => {
    expect(t.changes[0].was).toBe(14);
    expect(t.changes[1]).toMatchObject({ h: 11.5, d: 0.5, slots: [11.5, 16.5], yours: true });
  });
  it("zooms to the hours that matter, at least six", () => {
    expect([t.z0, t.z1]).toEqual([10, 18]);
    const short = timelineOf({ events: [{ title: "A", start: "12:00", end: "13:00" }] });
    expect(short.z1 - short.z0).toBeGreaterThanOrEqual(6);
  });
  it("knows today only from the date it was given", () => {
    expect(t.today).toBe(true);
    expect(timelineOf(data, "2026-11-19").today).toBe(false);
  });
  it("never throws on junk", () => {
    for (const junk of [null, 3, "x", [], { events: "no", changes: [null, 4] }]) expect(() => timelineOf(junk)).not.toThrow();
  });
});

describe("to-do", () => {
  it("reads items, their state, who and steps", () => {
    const items = todoOf({ items: [
      { id: "a", text: "Renew", who: "home", state: "doing", steps: [{ text: "Open", done: true }, "Fill"] },
      { text: "Yours", who: "you", state: "bogus" },
      { id: "c", state: "done" },
    ] });
    expect(items.map((i) => [i.id, i.who, i.state])).toEqual([["t:a", "home", "doing"], ["t:1:Yours", "you", "open"]]);
    expect(items[0].steps).toEqual([{ text: "Open", done: true }, { text: "Fill", done: false }]);
    expect(todoOf("nope")).toEqual([]);
  });
});

describe("triage", () => {
  it("reads cards into the four piles; an unknown pile is the Inbox", () => {
    const cards = triageOf({ cards: [
      { id: "l", from: "Landlord", title: "Lease", pile: "needs", question: "Renew?", options: ["Yes", "No", 3], source: "Gmail" },
      { title: "No pile", pile: "trash" },
      { from: "No title" },
    ] });
    expect(cards.map((c) => [c.id, c.pile])).toEqual([["g:l", "needs"], ["g:1:No pile", "inbox"]]);
    expect(cards[0]).toMatchObject({ options: ["Yes", "No", "3"], source: "gmail", from: "Landlord" });
    expect(cards[1].from).toBe("Unknown");
  });
});

describe("step words", () => {
  it("names Nightloom's own tools as Claude Code sees them (mcp__<server>__<tool>)", () => {
    expect(toolWords("mcp__nightloom__update_task")[0]).toBe("Updated the stage");
    expect(toolWords("update_task")[0]).toBe("Updated the stage");
  });
});

describe("the stage (sources)", () => {
  // Read from disk (vitest empties a `.css?raw` import); fs imported the way askLockK.test.ts does, which the app's
  // type check (no Node types) accepts.
  const fsP = import(/* @vite-ignore */ "node:" + "fs") as Promise<{ readFileSync(u: URL, enc: string): string }>;
  let fs: { readFileSync(u: URL, enc: string): string };
  beforeAll(async () => void (fs = await fsP));
  const read = (p: string) => fs.readFileSync(new URL(`./${p}`, import.meta.url), "utf8");
  it("uses no container query: WebKit reads them at width × the page zoom (fold.ts)", () => {
    for (const f of ["stage.css", "views/Timeline.svelte", "views/Triage.svelte", "views/Todo.svelte", "views/Watch.svelte", "views/Brief.svelte", "views/Browse.svelte", "views/Run.svelte", "views/Research.svelte"]) {
      expect(read(f).length, f).toBeGreaterThan(0);
      expect(read(f), f).not.toMatch(/^\s*@container/m);
    }
    expect(read("Stage.svelte")).toMatch(/class:narrow=\{oneW <= 760\}/); // one view's width: half the stage when split (batch 4)
  });
  it("animates a view switch only on his pick (no exit left to wait on behind the new view)", () => {
    const s = read("Stage.svelte");
    expect(s).toMatch(/in:viewIn\|global/);
    expect(s).toMatch(/out:viewOut\|global/);
    expect(s).toMatch(/picked \? hudOut\(node\) : \{ duration: 0 \}/);
  });
  it("draws a task's tab only in a view that is built", () => {
    expect(read("Stage.svelte")).toMatch(/const TASK_VIEWS = \["timeline", "todo", "triage", "browse", "run", "research", "brief"\]/);
  });
});
