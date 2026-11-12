// Item 656 (his "still dont see the bash text"): the newest passing line — the bottom one — is drawn whole, above
// Reticle's dashed bus: no bottom fade in the mask, a box that ends 24 px into the row, ink at 0.7 (was 0.5).
import { describe, expect, it } from "vitest";
import passingSrc from "./BashPassing.svelte?raw";

const rule = passingSrc.slice(passingSrc.indexOf("  .passing {"), passingSrc.indexOf("  .pl {"));

describe("the passing text can be seen (656)", () => {
  it("fades only its older lines, ends above the bus, and is not half-transparent", () => {
    expect(rule).toContain("mask: linear-gradient(180deg, transparent, #000 55%);");
    expect(rule).not.toMatch(/#000 \d+%, transparent\)/);
    expect(rule).toContain("height: 22px;");
    expect(rule).toContain("opacity: 0.7;");
  });
});
