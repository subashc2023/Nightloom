import { describe, expect, it } from "vitest";
import { exactTime, relativeTime, relativeTimeLong } from "./time";

// The message foot's time (nightshift backlog 123): the short form the
// sidebar has always used, the long form in words for the foot, and the
// exact moment for the hover. All measured from a `now` the caller passes,
// so a ticking clock can refresh the text on screen.

// A fixed "now" at 3 pm local time, so the same-day and yesterday rules
// are exercised without depending on when the suite runs.
const NOW = new Date(2026, 8, 16, 15, 0, 0).getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("relativeTime", () => {
  it("counts minutes and hours from the clock it is given", () => {
    expect(relativeTime(ago(20_000), NOW)).toBe("just now");
    expect(relativeTime(ago(5 * MIN), NOW)).toBe("5m ago");
    expect(relativeTime(ago(2 * HOUR), NOW)).toBe("2h ago");
  });
  it("says yesterday across midnight, then a date", () => {
    expect(relativeTime(ago(20 * HOUR), NOW)).toBe("yesterday");
    expect(relativeTime(ago(5 * 24 * HOUR), NOW)).toBe(new Date(NOW - 5 * 24 * HOUR).toLocaleDateString());
  });
  it("is empty for a time it cannot parse", () => {
    expect(relativeTime("not a time", NOW)).toBe("");
  });
});

describe("relativeTimeLong", () => {
  it("spells the unit out, singular and plural", () => {
    expect(relativeTimeLong(ago(20_000), NOW)).toBe("just now");
    expect(relativeTimeLong(ago(1 * MIN), NOW)).toBe("1 minute ago");
    expect(relativeTimeLong(ago(37 * MIN), NOW)).toBe("37 minutes ago");
    expect(relativeTimeLong(ago(1 * HOUR), NOW)).toBe("1 hour ago");
    expect(relativeTimeLong(ago(2 * HOUR), NOW)).toBe("2 hours ago");
    expect(relativeTimeLong(ago(20 * HOUR), NOW)).toBe("yesterday");
  });
  it("moves with the clock", () => {
    const at = ago(30 * MIN);
    expect(relativeTimeLong(at, NOW)).toBe("30 minutes ago");
    expect(relativeTimeLong(at, NOW + 45 * MIN)).toBe("1 hour ago");
  });
});

describe("exactTime", () => {
  it("is the locale's medium date and short time", () => {
    const at = new Date(2026, 8, 16, 15, 40).toISOString();
    expect(exactTime(at)).toBe(
      new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
    );
    // Whatever the locale, the year and the minute are in it.
    expect(exactTime(at)).toContain("2026");
    expect(exactTime(at)).toContain("40");
  });
  it("is empty for a time it cannot parse", () => {
    expect(exactTime("")).toBe("");
  });
});
