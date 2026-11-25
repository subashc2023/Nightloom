// Item 947: a Needs-you card's title or place name with no break in it (a URL, a path) wraps inside the card; it was
// drawn past the card's edge and clipped by the panel (seen at 1440x900 on the harness with a 180-letter title).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./stage.css", import.meta.url), "utf8");
const watch = readFileSync(new URL("./views/Watch.svelte", import.meta.url), "utf8");

describe("947: long Needs-you text wraps", () => {
  it("the card's question wraps anywhere", () => {
    expect(css).toMatch(/\.nd-q \{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere/);
  });
  it("the tag and place line sits in a wrapping span", () => {
    expect(css).toMatch(/\.nd-wh \{[^}]*overflow-wrap: anywhere/);
    expect(watch).toContain('<span class="nd-wh">{n.tag} · {n.where}</span>');
  });
});
