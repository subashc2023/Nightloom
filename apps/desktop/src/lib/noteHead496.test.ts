import { describe, expect, it } from "vitest";
import { leadsWithTitle, shownOf, splitExt, whoFoldKey } from "./noteHead";

describe("leadsWithTitle (item 496, blocker 1649)", () => {
  it("is true for a note whose first line is an H1", () => {
    expect(leadsWithTitle("# Overview\n\nText")).toBe(true);
    expect(leadsWithTitle("\n\n  # Overview")).toBe(true);
    expect(leadsWithTitle("# Overview\r\nText")).toBe(true);
  });
  it("skips a front-matter block", () => {
    expect(leadsWithTitle("---\ntitle: x\n---\n\n# Plan\n")).toBe(true);
    expect(leadsWithTitle("---\ntitle: x\n---\nbody")).toBe(false);
  });
  it("is false for an H2, a tag, plain text or an empty note", () => {
    expect(leadsWithTitle("## Section\n")).toBe(false);
    expect(leadsWithTitle("#tag line")).toBe(false);
    expect(leadsWithTitle("Times in AM/PM.\n# Later")).toBe(false);
    expect(leadsWithTitle("")).toBe(false);
    expect(leadsWithTitle("#")).toBe(false);
    expect(leadsWithTitle("    # indented code")).toBe(false);
  });
});

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
