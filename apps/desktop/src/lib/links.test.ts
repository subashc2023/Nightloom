import { describe, expect, it } from "vitest";
import { externalHref } from "./links";

function anchor(href: string | null, inner = "x"): HTMLElement {
  const a = document.createElement("a");
  if (href !== null) a.setAttribute("href", href);
  const span = document.createElement("span");
  span.textContent = inner;
  a.appendChild(span);
  document.body.appendChild(a);
  return span;
}

describe("externalHref (links in replies open in the browser, 2026-09-18)", () => {
  const origin = "tauri://localhost";
  it("hands an http(s) link to the browser, from a click on a child of the anchor", () => {
    expect(externalHref(anchor("https://arxiv.org/abs/2607.27250"), origin)).toBe(
      "https://arxiv.org/abs/2607.27250",
    );
    expect(externalHref(anchor("mailto:a@b.c"), origin)).toBe("mailto:a@b.c");
  });
  it("leaves fragments, same-origin, note links and non-anchors alone", () => {
    expect(externalHref(anchor("#top"), origin)).toBeNull();
    expect(externalHref(anchor("tauri://localhost/x"), origin)).toBeNull();
    expect(externalHref(anchor("note:thing"), origin)).toBeNull();
    expect(externalHref(anchor(null), origin)).toBeNull();
    expect(externalHref(document.createElement("div"), origin)).toBeNull();
    expect(externalHref(null, origin)).toBeNull();
  });
});
