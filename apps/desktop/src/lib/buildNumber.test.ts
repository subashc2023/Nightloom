import { describe, expect, it } from "vitest";
import { buildLabel } from "./buildNumber";

describe("buildLabel (item 832)", () => {
  it("names a numbered release build", () => {
    expect(buildLabel("222")).toBe("Build 222");
    expect(buildLabel(" 7\n")).toBe("Build 7");
  });
  it("calls anything else a dev build", () => {
    for (const raw of [undefined, "", "0", "abc", "12a", 5]) expect(buildLabel(raw)).toBe("dev");
  });
  it("reads the env at build time (unset under the test runner)", () => {
    expect(buildLabel()).toBe("dev");
  });
});
