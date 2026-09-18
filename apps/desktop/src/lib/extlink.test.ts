import { describe, expect, it } from "vitest";
import { externalHref } from "./extlink";

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
