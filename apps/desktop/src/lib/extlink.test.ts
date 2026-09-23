import { describe, expect, it } from "vitest";
import { externalHref, linkRoute, overlaps, parseLinkPref } from "./extlink";

describe("externalHref (links in replies open in the browser, 2026-09-18)", () => {
  const origin = "tauri://localhost";
  it("hands an http(s) or mailto link to the browser", () => {
    expect(externalHref("https://arxiv.org/abs/2607.27250", origin)).toBe(
      "https://arxiv.org/abs/2607.27250",
    );
    expect(externalHref("mailto:a@b.c", origin)).toBe("mailto:a@b.c");
  });
  it("leaves fragments, same-origin, note links and missing hrefs alone", () => {
    expect(externalHref("#top", origin)).toBeNull();
    expect(externalHref("tauri://localhost/x", origin)).toBeNull();
    expect(externalHref("/notes/x", origin)).toBeNull();
    expect(externalHref("note:thing", origin)).toBeNull();
    expect(externalHref(null, origin)).toBeNull();
    expect(externalHref("", origin)).toBeNull();
  });
});

describe("linkRoute (backlog 172: a web tab or the browser)", () => {
  const u = "https://example.com/a";
  it("sends a plain click where the setting says, and ⌘ to the other place", () => {
    expect(linkRoute(u, "browser", false)).toBe("browser");
    expect(linkRoute(u, "browser", true)).toBe("tab");
    expect(linkRoute(u, "tab", false)).toBe("tab");
    expect(linkRoute(u, "tab", true)).toBe("browser");
  });
  it("never makes a tab of mailto or anything not http(s)", () => {
    expect(linkRoute("mailto:a@b.c", "tab", false)).toBe("browser");
    expect(linkRoute("mailto:a@b.c", "browser", true)).toBe("browser");
  });
  it("reads the stored preference, the browser by default", () => {
    expect(parseLinkPref(null)).toBe("browser");
    expect(parseLinkPref("junk")).toBe("browser");
    expect(parseLinkPref("tab")).toBe("tab");
  });
});

describe("overlaps (a dialog over a web tab hides the page)", () => {
  const page = { left: 100, top: 100, right: 500, bottom: 400 };
  it("is true for any shared area and false for touching edges", () => {
    expect(overlaps(page, { left: 450, top: 50, right: 600, bottom: 120 })).toBe(true);
    expect(overlaps(page, { left: 500, top: 100, right: 600, bottom: 400 })).toBe(false);
    expect(overlaps(page, { left: 0, top: 0, right: 99, bottom: 99 })).toBe(false);
  });
});
