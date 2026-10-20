import { describe, expect, it } from "vitest";
import { STOP_ARM_MS, stopArmed, stopChordLabel, stopChordTarget } from "./stopButton";

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

/** Item 398, blocker 1506: ⌘. stops what the Stop on screen would. */
describe("what ⌘. stops", () => {
  it("the chat's turn while one runs", () => {
    expect(stopChordTarget({ asideFocused: false, asideBusy: false, turnBusy: true })).toBe("turn");
  });
  it("nothing when no turn runs", () => {
    expect(stopChordTarget({ asideFocused: false, asideBusy: false, turnBusy: false })).toBeNull();
  });
  it("an aside's answer when its box has the keyboard", () => {
    expect(stopChordTarget({ asideFocused: true, asideBusy: true, turnBusy: true })).toBe("aside");
    expect(stopChordTarget({ asideFocused: true, asideBusy: true, turnBusy: false })).toBe("aside");
  });
  it("never the chat's turn from an idle aside's box", () => {
    expect(stopChordTarget({ asideFocused: true, asideBusy: false, turnBusy: true })).toBeNull();
  });
  it("names the chord per platform", () => {
    expect(stopChordLabel(true)).toBe("⌘.");
    expect(stopChordLabel(false)).toBe("Ctrl+.");
  });
});
