import { describe, expect, it } from "vitest";
import type { TabContent } from "./tabs";
import { TABS_KEY, carryTabsTo, loadSavedWorkspaces, withCarried } from "./tabsStore";

/** A chat moved to another project takes its tab there (nightshift backlog 370). */

const chat = (session: string): TabContent => ({ kind: "chat", session });

function memory(): Pick<Storage, "getItem" | "setItem"> & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
}

describe("withCarried (backlog 370)", () => {
  it("gives a project with nothing stored a workspace of just the moved chat", () => {
    expect(withCarried(undefined, [chat("m"), chat("m")])).toEqual({ panes: [{ tabs: [chat("m")], active: 0 }], focused: 0 });
  });

  it("joins the stored focused pane at the end and comes to its front, other panes untouched", () => {
    const saved = {
      panes: [
        { tabs: [chat("a")], active: 0 },
        { tabs: [chat("b"), { kind: "note", scope: "project", name: "n.md" } as TabContent], active: 1, shells: 2 },
      ],
      focused: 1,
    };
    const out = withCarried(saved, [chat("m")]);
    expect(out.panes[0]).toEqual(saved.panes[0]);
    expect(out.panes[1].tabs).toEqual([chat("b"), saved.panes[1].tabs[1], chat("m")]);
    expect(out.panes[1].active).toBe(2);
    expect(out.panes[1].shells).toBe(2);
    expect(out.focused).toBe(1);
  });

  it("is one tab per chat: a chat already stored there is brought to the front, not doubled", () => {
    const out = withCarried({ panes: [{ tabs: [chat("m"), chat("b")], active: 1 }], focused: 0 }, [chat("m")]);
    expect(out.panes[0].tabs).toEqual([chat("m"), chat("b")]);
    expect(out.panes[0].active).toBe(0);
  });
});

describe("carryTabsTo (backlog 370)", () => {
  it("writes the target project's workspace and keeps every other project's", () => {
    const s = memory();
    s.setItem(TABS_KEY, JSON.stringify({ here: { panes: [{ tabs: [chat("x")], active: 0 }], focused: 0 } }));
    carryTabsTo(s, "there", [chat("m")]);
    const all = loadSavedWorkspaces(s);
    expect(all.here.panes[0].tabs).toEqual([chat("x")]);
    expect(all.there.panes[0].tabs).toEqual([chat("m")]);
  });

  it("writes nothing when the chat had no tab", () => {
    const s = memory();
    carryTabsTo(s, "there", []);
    expect(s.data[TABS_KEY]).toBeUndefined();
  });
});
