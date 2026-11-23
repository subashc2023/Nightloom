// Item 809: a "Told you" step's one-line summary drops Markdown marks (a heading showed as "## Needs you").
import { describe, expect, it } from "vitest";
import { plainLine } from "./steps";

describe("plainLine", () => {
  it("drops headings, bold, code ticks, bullets and link targets", () => {
    const md = "Three things need you today; the rest is handled.\n\n## Needs you\n- **The landlord's** lease question — see [the mail](https://mail.example/x)\n1. run `cargo fmt`";
    expect(plainLine(md)).toBe("Three things need you today; the rest is handled. Needs you The landlord's lease question — see the mail run cargo fmt");
  });
  it("leaves plain text and a mid-line # alone", () => {
    expect(plainLine("  Item #809 is on  the stage ")).toBe("Item #809 is on the stage");
  });
});
