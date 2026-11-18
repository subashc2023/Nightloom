import { describe, expect, it } from "vitest";
import { pickedOption } from "./askSettled";

describe("851: which option his answer picked", () => {
  const opts = ["Yes, ship it", "No, wait"];
  it("an exact label", () => expect(pickedOption(opts, "No, wait")).toBe(1));
  it("a label with the card's note", () => expect(pickedOption(opts, "Yes, ship it (note: after lunch)")).toBe(0));
  it("trims around his words", () => expect(pickedOption(opts, "  Yes, ship it\n")).toBe(0));
  it("typed words that are none of them", () => expect(pickedOption(opts, "Yes, but later")).toBe(-1));
  it("the longest label wins when one begins another", () =>
    expect(pickedOption(["Yes", "Yes (note: x)"], "Yes (note: x)")).toBe(1));
  it("no options", () => expect(pickedOption([], "anything")).toBe(-1));
});
