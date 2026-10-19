import { describe, expect, it } from "vitest";
import { dropPending, markPasted, takeDropped } from "./dropLook.svelte";

// Item 388: a paste's image chips land as dropped ones do.
describe("markPasted", () => {
  it("gives each pasted image chip its place, once, and opens the row", () => {
    markPasted(["image 1", "image 2"]);
    expect(dropPending()).toBe(true);
    expect(takeDropped("image 2")).toBe(1);
    expect(takeDropped("image 1")).toBe(0);
    expect(takeDropped("image 1")).toBeNull();
    expect(takeDropped("notes.pdf")).toBeNull();
  });
});
