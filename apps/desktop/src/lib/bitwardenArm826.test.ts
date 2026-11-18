import { describe, expect, it } from "vitest";
import { armBlocked, armedLine, clock12, nextClock, untilWords } from "./bitwardenArm";

describe("item 826: the pre-arm card's times", () => {
  const tonight = new Date(2026, 10, 18, 23, 30);
  it("ends at the next 8:00 AM", () => {
    const end = nextClock(tonight, "08:00")!;
    expect(end.getDate()).toBe(19);
    expect(clock12(end)).toBe("8:00 AM");
    expect(untilWords(end, tonight)).toBe("until 8:00 AM tomorrow");
  });
  it("keeps a later time today, and skips one too close", () => {
    const morning = new Date(2026, 10, 18, 7, 30);
    expect(nextClock(morning, "08:00")!.getDate()).toBe(18);
    expect(nextClock(morning, "08:00", 60 * 60 * 1000)!.getDate()).toBe(19);
  });
  it("refuses an unreadable time", () => {
    expect(nextClock(tonight, "25:00")).toBeNull();
    expect(nextClock(tonight, "eight")).toBeNull();
  });
  it("says names and end, never once it has ended", () => {
    const until = new Date(2026, 10, 19, 8, 0).toISOString();
    expect(armedLine({ names: ["GITHUB_TOKEN"], until }, tonight)).toBe(
      "Pre-armed: GITHUB_TOKEN (1 secret) until 8:00 AM tomorrow. The vault itself is locked.",
    );
    expect(armedLine({ names: ["A"], until }, new Date(2026, 10, 19, 9, 0))).toBeNull();
    expect(armedLine(null, tonight)).toBeNull();
  });
  it("blocks Pre-arm until set up, picked and timed", () => {
    expect(armBlocked(1, new Date(), false)).toMatch(/Set up/);
    expect(armBlocked(0, new Date(), true)).toMatch(/Tick/);
    expect(armBlocked(1, null, true)).toMatch(/end time/);
    expect(armBlocked(1, new Date(), true)).toBeNull();
  });
  it("12-hour clock at noon and midnight", () => {
    expect(clock12(new Date(2026, 0, 1, 0, 5))).toBe("12:05 AM");
    expect(clock12(new Date(2026, 0, 1, 12, 0))).toBe("12:00 PM");
  });
});
