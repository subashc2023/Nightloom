import { beforeEach, describe, expect, it } from "vitest";
import * as tabs from "./tabs";
import type { TabContent, Workspace } from "./tabs";
import { TABS_KEY, loadSavedWorkspaces, rebuild, saveWorkspaceFor, snapshot } from "./tabsStore";

/**
 * The workspace across a quit (nightshift backlog 201): what is stored,
 * what comes back, and that a broken store costs the layout only.
 */

const chat = (session: string): TabContent => ({ kind: "chat", session });

/** Two panes: [a, aside(a), b*] | [note, web*], the right one focused;
 *  shells: two in the right pane's dock. */
function sample(): { ws: Workspace; shells: Record<string, number> } {
  const left = tabs.makePane([
    tabs.makeTab(chat("a")),
    tabs.makeTab({ kind: "aside", session: "a", thread: 0 }),
    tabs.makeTab(chat("b")),
  ]);
  left.active = left.tabs[2].id;
  const right = tabs.makePane([
    tabs.makeTab({ kind: "note", scope: "project", name: "plan.md" }),
    tabs.makeTab({ kind: "web", url: "https://example.com/x", title: "X" }),
  ]);
  right.active = right.tabs[1].id;
  return { ws: { panes: [left, right], focused: right.id }, shells: { [right.id]: 2 } };
}

function shape(ws: Workspace): unknown {
  return {
    panes: ws.panes.map((p) => ({
      tabs: p.tabs.map((t) => t.content),
      active: p.tabs.findIndex((t) => t.id === p.active),
    })),
    focused: ws.panes.findIndex((p) => p.id === ws.focused),
  };
}

beforeEach(() => localStorage.clear());

describe("round trip", () => {
  it("brings back every pane, its tabs in order, the front tab, the focus and the shells", () => {
    const { ws, shells } = sample();
    saveWorkspaceFor(localStorage, "proj", snapshot(ws, (p) => shells[p] ?? 0));
    const saved = loadSavedWorkspaces(localStorage).proj;
    expect(saved).toBeDefined();
    const back = rebuild(saved!, (c) => c)!;
    expect(shape(back.ws)).toEqual(shape(ws));
    expect(back.shells).toEqual([{ pane: back.ws.panes[1].id, count: 2 }]);
  });

  it("mints fresh ids, so a rebuilt tab never collides with one made later", () => {
    const { ws } = sample();
    const back = rebuild(snapshot(ws), (c) => c)!;
    const before = new Set(tabs.allTabs(ws).map((t) => t.id));
    for (const t of tabs.allTabs(back.ws)) expect(before.has(t.id)).toBe(false);
    const later = tabs.makeTab(chat("z"));
    expect(tabs.allTabs(back.ws).some((t) => t.id === later.id)).toBe(false);
  });

  it("keeps each project's workspace apart", () => {
    const { ws } = sample();
    saveWorkspaceFor(localStorage, "one", snapshot(ws));
    saveWorkspaceFor(localStorage, "two", snapshot(tabs.emptyWorkspace()));
    const all = loadSavedWorkspaces(localStorage);
    expect(all.one.panes).toHaveLength(2);
    expect(all.two.panes).toHaveLength(1);
  });

  it("never stores the floating slot", () => {
    const { ws } = sample();
    tabs.openFloating(ws, { kind: "attachment", session: "a", turn: 1, index: 0, media: "image", name: "i.png" });
    expect(JSON.stringify(snapshot(ws))).not.toContain("i.png");
  });

  it("stores content through the caller's mapper (an aside's thread by place)", () => {
    const { ws } = sample();
    const saved = snapshot(ws, undefined, (c) => (c.kind === "aside" ? { ...c, thread: 7 } : c));
    expect(saved.panes[0].tabs[1]).toEqual({ kind: "aside", session: "a", thread: 7 });
  });
});

describe("a dropped target", () => {
  it("drops a tab whose target is gone and hands the front to its right neighbour", () => {
    const { ws } = sample();
    const saved = snapshot(ws);
    // The front tab of the left pane (chat b) was deleted while closed.
    const back = rebuild(saved, (c) => (c.kind === "chat" && c.session === "b" ? null : c))!;
    const left = back.ws.panes[0];
    expect(left.tabs.map((t) => t.content)).toEqual([chat("a"), { kind: "aside", session: "a", thread: 0 }]);
    // No right neighbour: the left one comes forward.
    expect(tabs.activeTab(left).content).toEqual({ kind: "aside", session: "a", thread: 0 });
  });

  it("prefers the right neighbour when there is one", () => {
    const pane = tabs.makePane([tabs.makeTab(chat("a")), tabs.makeTab(chat("gone")), tabs.makeTab(chat("c"))]);
    pane.active = pane.tabs[1].id;
    const back = rebuild(snapshot({ panes: [pane], focused: pane.id }), (c) =>
      c.kind === "chat" && c.session === "gone" ? null : c,
    )!;
    expect(tabs.activeTab(back.ws.panes[0]).content).toEqual(chat("c"));
  });

  it("drops a pane emptied by the drops, and its dock, and moves the focus", () => {
    const { ws, shells } = sample();
    const back = rebuild(
      snapshot(ws, (p) => shells[p] ?? 0),
      (c) => (c.kind === "note" || c.kind === "web" ? null : c),
    )!;
    expect(back.ws.panes).toHaveLength(1);
    expect(back.ws.focused).toBe(back.ws.panes[0].id);
    expect(back.shells).toEqual([]);
  });

  it("is null when nothing survives, so the caller opens the empty workspace", () => {
    const { ws } = sample();
    expect(rebuild(snapshot(ws), () => null)).toBeNull();
  });

  it("drops a second copy of a singleton in the other pane", () => {
    const left = tabs.makePane([tabs.makeTab({ kind: "nightshift" }), tabs.makeTab(chat("a"))]);
    const right = tabs.makePane([tabs.makeTab({ kind: "nightshift" })]);
    const back = rebuild(snapshot({ panes: [left, right], focused: right.id }), (c) => c)!;
    expect(back.ws.panes).toHaveLength(1);
    expect(back.ws.focused).toBe(back.ws.panes[0].id);
  });
});

describe("a malformed store", () => {
  it("reads broken JSON as nothing stored", () => {
    localStorage.setItem(TABS_KEY, "{not json");
    expect(loadSavedWorkspaces(localStorage)).toEqual({});
  });

  it("reads a wrong shape as nothing stored, and a bad entry costs that entry", () => {
    localStorage.setItem(TABS_KEY, JSON.stringify([1, 2]));
    expect(loadSavedWorkspaces(localStorage)).toEqual({});
    localStorage.setItem(
      TABS_KEY,
      JSON.stringify({
        bad: { panes: "no" },
        good: {
          panes: [{ tabs: [{ kind: "chat", session: "a" }, { kind: "bogus" }, 42, { kind: "web", url: "file:///etc" }], active: 9 }],
          focused: "x",
        },
      }),
    );
    const all = loadSavedWorkspaces(localStorage);
    expect(Object.keys(all)).toEqual(["good"]);
    expect(all.good.panes[0].tabs).toEqual([chat("a")]);
    // An out-of-range active and focus fall back rather than throw.
    const back = rebuild(all.good, (c) => c)!;
    expect(tabs.activeTab(back.ws.panes[0]).content).toEqual(chat("a"));
    expect(back.ws.focused).toBe(back.ws.panes[0].id);
  });

  it("keeps at most two panes", () => {
    const pane = { tabs: [chat("a")], active: 0 };
    localStorage.setItem(TABS_KEY, JSON.stringify({ p: { panes: [pane, pane, pane], focused: 0 } }));
    expect(loadSavedWorkspaces(localStorage).p.panes).toHaveLength(2);
  });
});
