import { describe, expect, it } from "vitest";
import {
  askedResume,
  CONTINUE_MIN_MS,
  continueMessage,
  continueTime,
  extractContinue,
  readResumes,
  WINDOW_MS,
  writeResumes,
} from "./chatResume";
import { pauseLabel, RESUME_MARGIN_MS } from "./limit";
import { RESET_MARGIN_MS } from "./schedule";
import promptSrc from "../../../../crates/nightloom-service/src/prompt.rs?raw";

// Item 543b (his words, ~1:00 AM): "oftentimes these models are gonna run to
// like 95% and then stop working then because they don't want to hit the
// limit. In that case I might just be cooked, right?" — the chat asks, in
// its reply, to be continued after the reset.

const NOW = Date.parse("2026-11-10T09:00:00Z");
const plan = (five: string | null, week: string | null = null) => ({
  five_hour: 95,
  seven_day: 50,
  five_hour_resets_at: five,
  seven_day_resets_at: week,
});

describe("543b — the line a chat ends its reply with", () => {
  it("is read with its time and what to do next; the last one counts", () => {
    expect(extractContinue('Parked at 95%.\n\n<continue-later at="reset">run wave B from the queue</continue-later>')).toEqual({
      at: "reset",
      text: "run wave B from the queue",
    });
    expect(extractContinue("<continue-later>go on</continue-later>")).toEqual({ at: "reset", text: "go on" });
    expect(
      extractContinue('<continue-later at="+45m">first</continue-later>\n\ntext\n\n<continue-later at="06:35">second</continue-later>'),
    ).toEqual({ at: "06:35", text: "second" });
  });
  it("a tag shown inside a code block or mid-sentence asks nothing", () => {
    expect(extractContinue('Use it like this:\n\n```\n<continue-later at="reset">x</continue-later>\n```\n')).toBeNull();
    expect(extractContinue('The tag is `<continue-later at="reset">x</continue-later>` in a reply.')).toBeNull();
    expect(extractContinue("no tag here")).toBeNull();
  });
  it("is the shape the engine note tells the model", () => {
    const m = /<continue-later at=\\"reset\\">[^<]*<\/continue-later>/.exec(promptSrc);
    expect(m).not.toBeNull();
    expect(extractContinue(m![0].replace(/\\"/g, '"'))?.at).toBe("reset");
  });
});

describe("543b — when it goes", () => {
  it("reset: just after the 5-hour window's reset; weekly: the week's", () => {
    const five = "2026-11-10T11:30:00Z";
    const week = "2026-11-12T10:00:00Z";
    expect(continueTime({ at: "reset" }, plan(five, week), NOW)).toBe(Date.parse(five) + RESET_MARGIN_MS);
    expect(continueTime({ at: "weekly" }, plan(five, week), NOW)).toBe(Date.parse(week) + RESET_MARGIN_MS);
  });
  it("no reset known (or one already past): the longest a window can still run", () => {
    expect(continueTime({ at: "reset" }, null, NOW)).toBe(NOW + WINDOW_MS);
    expect(continueTime({ at: "reset" }, plan("2026-11-10T08:00:00Z"), NOW)).toBe(NOW + WINDOW_MS);
    expect(continueTime({ at: "nonsense" }, null, NOW)).toBe(NOW + WINDOW_MS);
  });
  it("a delay or a clock time, never sooner than five minutes", () => {
    expect(continueTime({ at: "+45m" }, null, NOW)).toBe(NOW + 45 * 60_000);
    expect(continueTime({ at: "+2h" }, null, NOW)).toBe(NOW + 2 * 3600_000);
    expect(continueTime({ at: "+1m" }, null, NOW)).toBe(NOW + CONTINUE_MIN_MS);
    const t = continueTime({ at: "23:59" }, null, NOW);
    expect(new Date(t).getHours()).toBe(23);
    expect(t).toBeGreaterThan(NOW);
  });
});

describe("543b — the entry and its card", () => {
  it("says it is Nightloom's message, repeats what the chat said, and tells it how to ask again", () => {
    const text = continueMessage({ text: "run wave B" });
    expect(text).toMatch(/^\[Nightloom, not from Swaraag:/);
    expect(text).toContain("run wave B");
    expect(text).toContain("<continue-later>");
  });
  it("the card reads as asked, not as a limit pause, and the entry survives a relaunch", () => {
    const r = askedResume("c1", { id: "p", name: "P" }, { at: "+30m", text: "next" }, null, NOW);
    expect(r.why).toBe("asked");
    expect(r.at).toBe(NOW + 30 * 60_000);
    expect(r.pause!.resetsAtMs! + RESUME_MARGIN_MS).toBe(r.at);
    expect(pauseLabel(r.pause!, NOW)).toMatch(/^asked to be continued · at /);
    expect(pauseLabel(r.pause!, r.at! + 1)).toBe("asked to be continued · its time has come");
    expect(readResumes(writeResumes({ c1: r }))).toEqual({ c1: r });
  });
});
