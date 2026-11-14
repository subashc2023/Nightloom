import { describe, expect, it } from "vitest";
import rail from "../remote/RailSheet.svelte?raw";
import { LAYOUTS } from "./layout.svelte";

// Item 628 (his ask): the new look is called Jarvis everywhere he can see it — Settings' Layout buttons and the phone's.
describe("item 628: the layout is named Jarvis", () => {
  it("Settings → Layout lists Jarvis and Classic", () => {
    expect(LAYOUTS.map((l) => l.name)).toEqual(["Jarvis", "Classic"]);
    expect(LAYOUTS.map((l) => l.note).join(" ")).not.toContain("Filament IV");
  });
  it("the phone's layout switch says Jarvis", () => {
    expect(rail).toContain(">Jarvis</button>");
    expect(rail).not.toContain(">Filament IV</button>");
  });
});
