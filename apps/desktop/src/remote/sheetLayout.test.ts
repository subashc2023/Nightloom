import { describe, expect, it } from "vitest";
import { chatSheetSub, messagesLabel, sheetFit } from "./sheetLayout";

describe("chat sheet header (300 A11)", () => {
  it("counts one message in the singular", () => {
    expect(messagesLabel(1)).toBe("1 message");
    expect(messagesLabel(0)).toBe("0 messages");
    expect(messagesLabel(2)).toBe("2 messages");
  });
  it("joins project, count and time", () => {
    expect(chatSheetSub("Garden Planner", 1, "6:29 PM")).toBe("Garden Planner · 1 message · 6:29 PM");
    expect(chatSheetSub("Garden Planner", null, null)).toBe("Garden Planner");
  });
});

describe("sheet fit (300 A10, A22)", () => {
  it("sits on the bottom with no keyboard", () => {
    expect(sheetFit(874, 874, 0)).toEqual({ lift: 0, visible: 874, keyboard: false });
  });
  it("Safari's bars alone are not a keyboard", () => {
    expect(sheetFit(874, 800, 0).keyboard).toBe(false);
  });
  it("lifts over the keyboard and caps at the visible height", () => {
    expect(sheetFit(874, 480, 0)).toEqual({ lift: 394, visible: 480, keyboard: true });
    // The page scrolled to keep the caret in view: the lift shrinks by it.
    expect(sheetFit(874, 480, 100)).toEqual({ lift: 294, visible: 480, keyboard: true });
  });
});
