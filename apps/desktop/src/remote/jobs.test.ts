import { describe, expect, it } from "vitest";
import { costText, lastText, nextText, parseRepeat, readJobDraft, weekText, whenText, writeJobDraft, type Job } from "./jobs";

const job = (over: Partial<Job> = {}): Job => ({
  id: "j1",
  title: "Check CI",
  text: "check CI",
  every_words: "Every day at 8:00 AM",
  read_only: true,
  project: null,
  chat: null,
  paused: false,
  next_run: "2026-11-17T16:00:00Z",
  running: null,
  last: null,
  week: { points: 0, runs: 0 },
  note: null,
  runs: 0,
  ...over,
});

describe("repeat every … (item 746)", () => {
  it("reads the schedule and the message out of what he typed or said", () => {
    expect(parseRepeat("repeat every morning: check CI and tell me what failed")).toEqual({ every: "every morning", text: "check CI and tell me what failed" });
    expect(parseRepeat("Repeat every weekday at 9:30am: summarise new issues")).toEqual({ every: "every weekday at 9:30am", text: "summarise new issues" });
    expect(parseRepeat("repeat every 2 hours, check the deploy")).toEqual({ every: "every 2 hours", text: "check the deploy" });
    expect(parseRepeat("repeat each Monday and Thursday at 9am - read the backlog")).toEqual({ every: "each Monday and Thursday at 9am", text: "read the backlog" });
    expect(parseRepeat("repeat every mon, wed and fri at 6pm: stretch")).toEqual({ every: "every mon, wed and fri at 6pm", text: "stretch" });
  });

  it("leaves an ordinary message alone", () => {
    expect(parseRepeat("please repeat every step of that")).toBeNull();
    expect(parseRepeat("repeat that")).toBeNull();
    expect(parseRepeat("repeat every morning")).toBeNull();
    expect(parseRepeat("repeat every morning:   ")).toBeNull();
  });
});

describe("the jobs list's words", () => {
  const now = new Date(2026, 10, 16, 12, 28);
  const local = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).toISOString();

  it("says times in 12-hour words", () => {
    expect(whenText(local(16, 15), now)).toBe("today 3:00 PM");
    expect(whenText(local(17, 8), now)).toBe("tomorrow 8:00 AM");
    expect(whenText(local(19, 9, 30), now)).toBe("Thu 9:30 AM");
    expect(whenText(local(30, 9), now)).toBe("Nov 30, 9:00 AM");
  });

  it("says the next run, or why there is none", () => {
    expect(nextText(job({ next_run: local(17, 8) }), now)).toBe("Next run: tomorrow 8:00 AM");
    expect(nextText(job({ paused: true }), now)).toBe("Paused");
    expect(nextText(job({ running: { started: local(16, 12) } }), now)).toBe("Running now");
    expect(nextText(job({ note: "waiting — its project is not open on the Mac" }), now)).toBe("Waiting — its project is not open on the Mac");
    expect(nextText(job({ next_run: local(16, 12) }), now)).toBe("Next run: due now");
  });

  it("says the last result and what it cost of the weekly limit", () => {
    expect(lastText(job(), now)).toBe("Has not run yet");
    const last = { started: local(16, 8), ended: local(16, 8, 2), outcome: "done" as const, summary: "2 red", week_points: 2, week_after: 42 };
    expect(lastText(job({ last }), now)).toBe("Last run today 8:02 AM — finished · 2% of the week");
    expect(lastText(job({ last: { ...last, outcome: "failed", week_points: 0 } }), now)).toBe("Last run today 8:02 AM — failed · under 1% of the week");
    expect(costText(null)).toBe("cost not read");
    expect(weekText(job())).toBe("");
    expect(weekText(job({ week: { points: 5, runs: 3 } }))).toBe("This week: 3 runs, 5% of the weekly limit");
    expect(weekText(job({ week: { points: 0, runs: 1 } }))).toBe("This week: 1 run, under 1% each");
  });
});

describe("the new-job form's draft", () => {
  it("is kept until it is saved or discarded", () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    expect(readJobDraft(store)).toBeNull();
    writeJobDraft({ every: "every morning", text: "check", title: "" }, store);
    expect(readJobDraft(store)).toEqual({ every: "every morning", text: "check", title: "" });
    writeJobDraft(null, store);
    expect(readJobDraft(store)).toBeNull();
  });
});
