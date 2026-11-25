import { describe, expect, it } from "vitest";
import {
  asOfWords,
  doneRows,
  emptyHomeKept,
  headerWords,
  homeDraftKey,
  homeTarget,
  isFolded,
  jobsWords,
  loadHomeKept,
  markScanRead,
  needRows,
  percentWords,
  readHomeKept,
  runningLine,
  saveHomeKept,
  scanText,
  scanWhen,
  stopWords,
  toggleFold,
  tokensShort,
  withScroll,
} from "./homeFirst";
import { draftKey, type HomeTodayWire } from "./client";
import type { Job } from "./jobs";

const today: HomeTodayWire = { points: 0.3, cap: 1, week: 64, five_hour: 55, stop: null };
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16);

function job(over: Partial<Job>): Job {
  return {
    id: "j1",
    title: "Home — Morning scan",
    text: "x",
    every_words: "every day at 8:00 AM",
    read_only: true,
    project: "home",
    chat: null,
    paused: false,
    next_run: "2026-11-18T16:00:00Z",
    running: null,
    last: null,
    week: { points: 0, runs: 0 },
    note: null,
    runs: 0,
    ...over,
  };
}

describe("the header (763 H8)", () => {
  it("says how many need him and today's share of the week", () => {
    expect(headerWords(3, today)).toBe("Home · 3 need you · today 0.3% of the week");
    expect(headerWords(1, today)).toBe("Home · 1 needs you · today 0.3% of the week");
    expect(headerWords(0, { ...today, points: 12.4 })).toBe("Home · nothing needs you · today 12% of the week");
  });
  it("leaves the percent off when the host has no /home/today", () => {
    expect(headerWords(2, null)).toBe("Home · 2 need you");
  });
  it("words small and zero percents plainly", () => {
    expect(percentWords(0)).toBe("0%");
    expect(percentWords(0.04)).toBe("under 0.1%");
    expect(percentWords(2.25)).toBe("2.3%");
  });
  it("says why Home's runs are stopped, and nothing when they are not", () => {
    expect(stopWords({ ...today, stop: "the 5-hour window is at 82%" })).toBe("Home's own runs are paused: the 5-hour window is at 82%");
    expect(stopWords(today)).toBeNull();
    expect(stopWords(null)).toBeNull();
  });
  it("says 'as of' only for the away server's copy", () => {
    expect(asOfWords(false, 1, clock)).toBeNull();
    expect(asOfWords(true, Date.UTC(2026, 10, 17, 23, 40), clock)).toBe("The Mac is not answering · as of 23:40");
    expect(asOfWords(true, null, clock)).toBe("The Mac is not answering · the away server's copy");
  });
});

describe("Needs you", () => {
  const feed = [
    { what: "done", chat: "d", label: "Signup", at: 5 },
    { what: "approval", chat: "a", label: "Scorer review", at: 9 },
    { what: "question", chat: "h", label: "Home", at: 7 },
    { what: "stuck", chat: "s", label: "", at: 3 },
  ];
  it("lists what waits newest first, then jobs, then held blockers; done rows are not needs", () => {
    const rows = needRows(
      feed,
      [job({ wanted: { at: "2026-11-17T08:00:00Z", what: ["edit files"] } }), job({ id: "j2" })],
      [{ project: "p1", project_name: "Nightloom", id: "2084", item: "763", question: "Which layout?" }],
      { chat: null, label: null, pending: 0 },
    );
    expect(rows.map((r) => r.key)).toEqual(["chat:a", "chat:h", "chat:s", "job:j1", "blocker:p1:2084"]);
    expect(rows[2].title).toBe("A new chat");
    expect(rows[4].line).toBe("Which layout?");
  });
  it("counts the open chat's own approvals once", () => {
    expect(needRows(feed, [], [], { chat: "a", label: "Scorer review", pending: 2 }).filter((r) => r.chat === "a")).toHaveLength(1);
    const rows = needRows([], [], [], { chat: "z", label: "Budget", pending: 2 });
    expect(rows).toEqual([expect.objectContaining({ key: "chat:z", title: "Budget", line: "2 approvals waiting" })]);
  });
});

describe("Done since you looked", () => {
  const rows = [
    { at: "2026-11-17T08:00:00Z", kind: "scan", line: "Morning scan · 2 waiting" },
    { at: "2026-11-17T09:00:00Z", kind: "done", chat: "c", line: "Finished" },
    { at: "2026-11-17T07:00:00Z", kind: "question", chat: "q", line: "Has a question" },
    { at: "2026-11-16T07:00:00Z", kind: "failed", chat: "f", line: "Failed" },
  ];
  it("keeps news newer than his last look, newest first", () => {
    expect(doneRows(rows, "2026-11-17T00:00:00Z").map((r) => r.kind)).toEqual(["done", "scan"]);
    expect(doneRows(rows, null).map((r) => r.kind)).toEqual(["done", "scan", "failed"]);
  });
});

describe("the scan card", () => {
  it("says when it ran, or that it was skipped, or which day it is from", () => {
    const ran = Date.UTC(2026, 10, 17, 8, 0);
    expect(scanWhen({ date: "2026-11-17", text: "", ran_at: ran, today: true, skipped: null }, clock)).toBe("ran 08:00");
    expect(scanWhen({ date: "2026-11-17", text: "", ran_at: ran, today: true, skipped: "5-hour at 82%" }, clock)).toBe("skipped · ran 08:00");
    expect(scanWhen({ date: "2026-11-16", text: "", ran_at: ran, today: false, skipped: null }, clock)).toBe("from 2026-11-16 · ran 08:00");
  });
  it("cuts a page past 200 words and says so", () => {
    expect(scanText("a b c", 5)).toEqual({ text: "a b c", cut: false });
    expect(scanText("a b c d e f g", 3)).toEqual({ text: "a b c …", cut: true });
  });
});

describe("Running", () => {
  it("names time in and context size", () => {
    const now = 10 * 60_000;
    expect(runningLine({ chat: "a", title: "x", since: now - 4 * 60_000 }, now, 212_345)).toBe("4 min in · 212k context");
    expect(runningLine({ chat: "a", title: "x", since: now, waiting: 1 }, now)).toBe("just started · 1 approval waiting");
    expect(runningLine({ chat: "a", title: "x", since: null }, now)).toBe("running");
    expect(tokensShort(8_400)).toBe("8.4k");
    expect(tokensShort(1_250_000)).toBe("1.3M");
  });
});

describe("the Jobs row", () => {
  it("counts the jobs and names the next run", () => {
    expect(jobsWords([], clock)).toBe("No jobs yet");
    expect(jobsWords([job({}), job({ id: "b", title: "CI", next_run: "2026-11-18T09:00:00Z" })], clock)).toBe("2 jobs · next CI at 09:00");
    expect(jobsWords([job({ paused: true })], clock)).toBe("1 job · all paused");
  });
});

describe("the place kept: scroll and folds", () => {
  it("opens a new scan, folds it once read, and a hand fold holds for that page only", () => {
    let k = emptyHomeKept();
    expect(isFolded(k, "scan", "2026-11-17")).toBe(false);
    k = markScanRead(k, "2026-11-17");
    expect(isFolded(k, "scan", "2026-11-17")).toBe(true);
    expect(isFolded(k, "scan", "2026-11-18"), "a new day's page opens").toBe(false);
    k = toggleFold(k, "scan", "2026-11-17");
    expect(isFolded(k, "scan", "2026-11-17"), "he opened it again").toBe(false);
    expect(isFolded(k, "scan", "2026-11-18")).toBe(false);
  });
  it("keeps every other section's fold as he left it", () => {
    let k = toggleFold(emptyHomeKept(), "done", null);
    expect(isFolded(k, "done", null)).toBe(true);
    expect(isFolded(k, "running", null)).toBe(false);
    k = toggleFold(k, "done", null);
    expect(isFolded(k, "done", null)).toBe(false);
  });
  it("round-trips through storage and rejects junk field by field", () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const k = withScroll(toggleFold(markScanRead(emptyHomeKept(), "2026-11-17"), "running", null), 412.6);
    saveHomeKept(k, store);
    expect(loadHomeKept(store)).toEqual({ scroll: 413, folds: { running: true }, scanRead: "2026-11-17", scanFoldFor: null, handledOpen: false, marked: {} });
    expect(readHomeKept({ scroll: -3, folds: { needs: "yes", done: true, bogus: true }, scanRead: 4 })).toEqual({
      scroll: 0,
      folds: { done: true },
      scanRead: null,
      scanFoldFor: null,
      handledOpen: false,
      marked: {},
    });
    expect(loadHomeKept({ getItem: () => "{not json" })).toEqual(emptyHomeKept());
  });
});

describe("Tell Home", () => {
  it("sends to today's Home chat, else starts one in Home's project", () => {
    expect(homeTarget({ project: "home", chat: "c1" })).toEqual({ chat: "c1" });
    expect(homeTarget({ project: "home", chat: null })).toEqual({ project: "home" });
    expect(homeTarget(null)).toBeNull();
  });
  it("shares its draft with the Home chat's own composer", () => {
    expect(homeDraftKey({ project: "home", chat: "c1" })).toBe(draftKey("c1", null));
    expect(homeDraftKey({ project: "home", chat: null })).toBe(draftKey(null, "home"));
  });
});

// Item 945: Nightshift's held blockers are one folded line under Needs you, not rows of it.
import { heldWords as heldWords945, isFolded as isFolded945, emptyHomeKept as emptyKept945, toggleFold as toggleFold945, readHomeKept as readKept945 } from "./homeFirst";
describe("held blockers on the phone's Home (item 945)", () => {
  it("is folded until he opens it, and the fold is kept", () => {
    const k = emptyKept945();
    expect(isFolded945(k, "held", null)).toBe(true);
    expect(isFolded945(k, "needs", null)).toBe(false);
    const open = toggleFold945(k, "held", null);
    expect(isFolded945(open, "held", null)).toBe(false);
    expect(isFolded945(readKept945(JSON.parse(JSON.stringify(open))), "held", null)).toBe(false);
  });
  it("says how many in plain words", () => {
    expect(heldWords945(1)).toBe("Nightshift · 1 held blocker");
    expect(heldWords945(3)).toBe("Nightshift · 3 held blockers");
  });
});

describe("the header before Needs you was read (947)", () => {
  it("says it has not read rather than 'nothing needs you'", () => {
    expect(headerWords(0, today, false)).toBe("Home · not read yet · today 0.3% of the week");
    expect(headerWords(2, today, false)).toBe("Home · 2 need you · today 0.3% of the week");
    expect(headerWords(0, today)).toBe("Home · nothing needs you · today 0.3% of the week");
  });
});
