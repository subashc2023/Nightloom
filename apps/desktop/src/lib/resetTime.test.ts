// Blocker 1812: reset times read 12-hour AM/PM everywhere they show.
import { describe, expect, it } from "vitest";
import { resetLong, resetText } from "./resetTime";

const at = (h: number, m: number, day = 10) => new Date(2026, 10, day, h, m, 0);
const NOW = at(18, 5).getTime();

describe("resetText (blocker 1812)", () => {
  it("reads today's reset in 12-hour time", () => {
    expect(resetText(at(21, 40).toISOString(), NOW)).toBe("resets 9:40 PM");
    expect(resetText(at(9, 5).toISOString(), NOW)).toBe("resets 9:05 AM");
    expect(resetText(at(0, 0).toISOString(), NOW)).toBe("resets 12:00 AM");
    expect(resetText(at(12, 30).toISOString(), NOW)).toBe("resets 12:30 PM");
  });

  it("names the day for another day's reset", () => {
    // 2026-11-12 is a Thursday.
    expect(resetText(at(9, 0, 12).toISOString(), NOW)).toBe("resets Thu 9:00 AM");
    expect(resetText(at(21, 40, 12).toISOString(), NOW)).toBe("resets Thu 9:40 PM");
  });

  it("never shows a 24-hour time", () => {
    for (let h = 0; h < 24; h++) {
      expect(resetText(at(h, 15).toISOString(), NOW)).toMatch(/ (1[0-2]|[1-9]):15 (AM|PM)$/);
    }
  });

  it("says so when the time is missing or broken", () => {
    expect(resetText(null, NOW)).toBe("reset time unknown");
    expect(resetText("not a date", NOW)).toBe("reset time unknown");
  });
});

describe("resetLong (the plan chip's tooltip)", () => {
  it("reads date and 12-hour time", () => {
    expect(resetLong(at(21, 40).toISOString())).toBe("resets Tue, Nov 10, 9:40 PM");
    expect(resetLong(null)).toBe("reset time unknown");
  });
});
