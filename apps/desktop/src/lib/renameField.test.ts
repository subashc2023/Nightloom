import { describe, expect, it } from "vitest";
import { renamedTo, selectAllOnMount } from "./renameField";

/** A field that records what was done to it, in order. */
function field(active: { el: unknown }) {
  const calls: string[] = [];
  const f = {
    calls,
    focus() {
      calls.push("focus");
      active.el = f;
    },
    select() {
      calls.push("select");
    },
    ownerDocument: {
      get activeElement() {
        return active.el;
      },
    },
  };
  return f;
}

describe("selectAllOnMount (backlog 376)", () => {
  it("focuses the field and selects its whole text at once", () => {
    const active = { el: null as unknown };
    const f = field(active);
    selectAllOnMount(f, () => {});
    expect(f.calls).toEqual(["focus", "select"]);
    expect(active.el).toBe(f);
  });

  it("selects again on the next tick when the closing menu took the focus", () => {
    const active = { el: null as unknown };
    const f = field(active);
    let tick: () => void = () => {};
    selectAllOnMount(f, (g) => (tick = g));
    active.el = "the menu button";
    tick();
    expect(f.calls).toEqual(["focus", "select", "focus", "select"]);
  });

  it("leaves the field alone on the next tick when it kept the focus (he may be typing)", () => {
    const active = { el: null as unknown };
    const f = field(active);
    let tick: () => void = () => {};
    selectAllOnMount(f, (g) => (tick = g));
    tick();
    expect(f.calls).toEqual(["focus", "select"]);
  });
});

describe("renamedTo (backlog 376)", () => {
  it("commits the typed name, trimmed", () => {
    expect(renamedTo("  New name ", "Old name")).toBe("New name");
  });
  it("is a cancel when emptied or unchanged", () => {
    expect(renamedTo("   ", "Old name")).toBeNull();
    expect(renamedTo("Old name ", "Old name")).toBeNull();
  });
});
