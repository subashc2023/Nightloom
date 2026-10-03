import { describe, expect, it } from "vitest";
import { ghostFor } from "./suggestions.svelte";

// The ghost line (nightshift backlog 083): shown over an empty box only.
describe("ghostFor", () => {
  it("shows the suggestion over an empty box and nothing once typing starts", () => {
    expect(ghostFor("Write the code", "")).toBe("Write the code");
    expect(ghostFor("Write the code", "W")).toBeNull();
    expect(ghostFor(null, "")).toBeNull();
  });
});
