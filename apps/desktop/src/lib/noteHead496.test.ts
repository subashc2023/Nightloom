import { describe, expect, it } from "vitest";
import { shownOf, splitExt, whoFoldKey } from "./noteHead";

describe("splitExt", () => {
  it("dims the extension only", () => {
    expect(splitExt("overview.md")).toEqual({ stem: "overview", ext: ".md" });
    expect(splitExt("a.b.tex")).toEqual({ stem: "a.b", ext: ".tex" });
    expect(splitExt("README")).toEqual({ stem: "README", ext: "" });
    expect(splitExt(".env")).toEqual({ stem: ".env", ext: "" });
  });
});

describe("shownOf / whoFoldKey", () => {
  it("Preview wins over the mode underneath", () => {
    expect(shownOf("plain", false)).toBe("plain");
    expect(shownOf("formatted", false)).toBe("formatted");
    expect(shownOf("plain", true)).toBe("preview");
  });
  it("keys the fold per scope", () => {
    expect(whoFoldKey("memory")).toBe("note-who:memory");
  });
});
