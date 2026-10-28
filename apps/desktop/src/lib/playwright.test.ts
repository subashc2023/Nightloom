import { describe, expect, it } from "vitest";
import { PLAYWRIGHT_BUTTONS, PLAYWRIGHT_DECLINED, isPlaywright, playwrightAction } from "./playwright";
import { routeNote } from "./askNote";

describe("Playwright's card (backlog 367)", () => {
  it("knows Playwright's tools and nothing else", () => {
    expect(isPlaywright("mcp__playwright__browser_navigate")).toBe(true);
    expect(isPlaywright("mcp__claude-in-chrome__navigate")).toBe(false);
    expect(isPlaywright("Bash")).toBe(false);
  });

  it("has his three buttons, in his order, each its own decision", () => {
    expect(PLAYWRIGHT_BUTTONS.map((b) => b.label)).toEqual(["Allow once", "Allow for this chat", "Deny"]);
    expect(PLAYWRIGHT_BUTTONS.map((b) => b.decision)).toEqual(["allow", "always", "deny"]);
  });

  it("names the action: the tool in words and its URL or element", () => {
    expect(playwrightAction("mcp__playwright__browser_navigate", { url: "https://example.com" })).toEqual({
      tool: "navigate",
      target: "https://example.com",
    });
    expect(
      playwrightAction("mcp__playwright__browser_click", { element: "Sign in button", ref: "e12" }),
    ).toEqual({ tool: "click", target: "Sign in button" });
    expect(playwrightAction("mcp__playwright__browser_snapshot", {})).toEqual({ tool: "snapshot", target: null });
  });

  it("denies in his words when no note was typed, and with the note when one was", () => {
    expect(routeNote("deny", "", PLAYWRIGHT_DECLINED)).toEqual({ reason: PLAYWRIGHT_DECLINED });
    expect(routeNote("deny", "not that site", PLAYWRIGHT_DECLINED)).toEqual({ reason: "not that site" });
    expect(routeNote("allow", "", PLAYWRIGHT_DECLINED)).toEqual({});
  });
});
