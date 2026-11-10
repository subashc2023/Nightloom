// Item 551 (a bug he reported): Claude's browser tab passes nothing he does
// to the page until he clicks into it. One test per kind of input, then
// every way the tab stops taking input, then the wiring in the view.
import { describe, expect, it } from "vitest";
import viewSrc from "./ClaudeBrowserView.svelte?raw";
import { INPUT_KINDS, InputGate, wheelKind, type DisarmCause } from "./claudeBrowser";

describe("the input gate (551)", () => {
  for (const kind of INPUT_KINDS) {
    it(`passes no ${kind} before a click, held or not`, () => {
      const g = new InputGate();
      expect(g.allows(kind, false)).toBe(false);
      expect(g.allows(kind, true)).toBe(false);
    });
    it(`passes ${kind} once clicked into${kind === "move" ? " (and only while he holds the browser)" : ""}`, () => {
      const g = new InputGate();
      g.press();
      expect(g.allows(kind, true)).toBe(true);
      expect(g.allows(kind, false)).toBe(kind !== "move");
    });
  }

  it("does not pass on the arming click itself, and passes the next one", () => {
    const changes: boolean[] = [];
    const g = new InputGate((a) => changes.push(a));
    expect(g.press()).toBe(true);
    expect(g.release()).toBe(false);
    expect(g.press()).toBe(false);
    expect(g.release()).toBe(true);
    expect(changes).toEqual([true]);
  });

  const causes: DisarmCause[] = ["outside-click", "escape", "window-blur", "focus-left", "tab-away", "chat-switch", "not-live"];
  for (const cause of causes) {
    it(`stops passing everything on ${cause}, until the next click`, () => {
      const changes: boolean[] = [];
      const g = new InputGate((a) => changes.push(a));
      g.press();
      g.release();
      g.disarm(cause);
      for (const k of INPUT_KINDS) expect(g.allows(k, true)).toBe(false);
      expect(changes).toEqual([true, false]);
      // A disarm mid-press drops that press's release too.
      expect(g.press()).toBe(true);
      g.disarm(cause);
      expect(g.release()).toBe(false);
    });
  }

  it("tells a scroll, a sideways swipe and a pinch apart", () => {
    expect(wheelKind({ deltaX: 0, deltaY: 40, ctrlKey: false })).toBe("wheel");
    expect(wheelKind({ deltaX: -60, deltaY: 3, ctrlKey: false })).toBe("swipe");
    expect(wheelKind({ deltaX: 0, deltaY: 4, ctrlKey: true })).toBe("pinch");
  });

  it("a three-finger swipe sequence over an unclicked tab sends nothing", () => {
    const g = new InputGate();
    let sent = 0;
    for (let i = 0; i < 30; i++) {
      const k = wheelKind({ deltaX: -20 - i, deltaY: 1, ctrlKey: false });
      if (g.allows(k, false)) sent++;
    }
    expect(sent).toBe(0);
  });
});

describe("the gate wired in the tab (551)", () => {
  it("checks the gate before sending each kind", () => {
    expect(viewSrc).toContain('if (!gate.allows("move", heldByMe)) return;');
    expect(viewSrc).toContain("if (!gate.allows(wheelKind(e), heldByMe)) return;");
    expect(viewSrc).toContain('if (!gate.allows("key", heldByMe)) return;');
    expect(viewSrc).toContain('if (!gate.allows("text", heldByMe)) return;');
    expect(viewSrc.match(/gate\.allows\("text", heldByMe\)/g)?.length).toBe(3);
    expect(viewSrc).toContain("if (!gate.release() || e.detail > 2) return;");
  });

  it("disarms on every way out", () => {
    for (const c of ["outside-click", "escape", "window-blur", "focus-left", "tab-away", "chat-switch", "not-live"]) {
      expect(viewSrc).toContain(`gate.disarm("${c}")`);
    }
    expect(viewSrc).toContain('window.addEventListener("pointerdown", onDownAnywhere, true);');
  });

  it("the key sink is reached only by a click, never by Tab", () => {
    expect(viewSrc).toContain('tabindex="-1"');
  });
});

describe("every way out of his takeover hands the browser back (552)", () => {
  it("the tab re-reads who holds the browser at each edge of a turn", () => {
    expect(viewSrc).toMatch(/void app\.busy;\s*void startBrowsers\(\);\s*void readStatus\(session\);/);
  });
  it("the last tab gone stops watching (the backend then hands the browser back)", () => {
    expect(viewSrc).toMatch(/if \(away \|\| !docVisible\) return;\s*watch\(s, true\);\s*return \(\) => watch\(s, false\);/);
  });
});
