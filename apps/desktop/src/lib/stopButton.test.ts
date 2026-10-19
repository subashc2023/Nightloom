import { describe, expect, it } from "vitest";
import { STOP_ARM_MS, stopArmed } from "./stopButton";

/** Item 398: the Stop that takes Send's place ignores a double-click's second click. */
describe("the Stop's arming", () => {
  it("ignores a click inside the arming window (a double-click on Send)", () => {
    expect(stopArmed(1000, 1000 + 250)).toBe(false);
    expect(stopArmed(1000, 1000)).toBe(false);
  });
  it("takes a click once armed", () => {
    expect(stopArmed(1000, 1000 + STOP_ARM_MS)).toBe(true);
    expect(stopArmed(1000, 60_000)).toBe(true);
  });
  it("is shorter than half a second, so a deliberate Stop is never refused", () => {
    expect(STOP_ARM_MS).toBeLessThanOrEqual(500);
    expect(STOP_ARM_MS).toBeGreaterThanOrEqual(300);
  });
});
