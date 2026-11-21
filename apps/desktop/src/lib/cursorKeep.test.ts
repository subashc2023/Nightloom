import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));

import { kindFor } from "./cursorKeep";

/**
 * Item 828: the cursor the page asks for, in WebKit's order (an explicit
 * CSS cursor, an editable box, a link, text, else the arrow).
 */
describe("kindFor", () => {
  it("is the I-beam in a box he types in, whatever is under the mouse", () => {
    expect(kindFor("auto", true, false, false)).toBe("ibeam");
    expect(kindFor("auto", true, true, true)).toBe("ibeam");
  });
  it("is the I-beam over selectable text, the arrow beside it", () => {
    expect(kindFor("auto", false, false, true)).toBe("ibeam");
    expect(kindFor("auto", false, false, false)).toBe("arrow");
  });
  it("is the hand over a link outside a box", () => {
    expect(kindFor("auto", false, true, true)).toBe("hand");
  });
  it("follows an explicit CSS cursor first", () => {
    expect(kindFor("pointer", true, false, true)).toBe("hand");
    expect(kindFor("text", false, false, false)).toBe("ibeam");
    expect(kindFor("default", true, false, true)).toBe("arrow");
  });
  it("leaves every other cursor (a resize edge, a grab handle) to WebKit", () => {
    expect(kindFor("row-resize", false, false, false)).toBeNull();
    expect(kindFor("grab", false, false, true)).toBeNull();
    expect(kindFor("progress", true, false, false)).toBeNull();
  });
});
