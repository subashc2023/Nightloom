// Item 874 (his blocker 2203): Nightshift is just another tab — it takes the current tab over in place, and Chats or
// Notes turn that same tab back into what it held; other tabs are untouched.
import { describe, expect, it } from "vitest";
import { activeTab, focusedPane, land, makeTab, takeBack, type TabContent, type Workspace } from "./tabs";

const chat = (session: string): TabContent => ({ kind: "chat", session });
function ws2(): Workspace {
  const a = makeTab(chat("a"));
  const b = makeTab(chat("b"));
  const pane = { id: "p1", tabs: [a, b], active: b.id };
  return { panes: [pane], focused: "p1" };
}

describe("Nightshift takes the tab over and gives it back (874)", () => {
  it("turns the current tab into Nightshift and back into the same chat; the other tab is untouched", () => {
    const ws = ws2();
    const pane = focusedPane(ws);
    const id = pane.active;
    land(ws, pane, { kind: "nightshift" }, "replace");
    expect(pane.tabs.length).toBe(2);
    expect(activeTab(pane).id).toBe(id);
    expect(activeTab(pane).content.kind).toBe("nightshift");
    const t = takeBack(ws, () => true);
    expect(t?.id).toBe(id);
    expect(activeTab(pane).content).toEqual(chat("b"));
    expect(pane.tabs[0].content).toEqual(chat("a"));
    expect(activeTab(pane).back).toBeUndefined();
  });
  it("nothing to turn back when the tab never held anything else, or what it held is gone", () => {
    const ws = ws2();
    const pane = focusedPane(ws);
    expect(takeBack(ws, () => true)).toBeNull();
    land(ws, pane, { kind: "nightshift" }, "replace");
    expect(takeBack(ws, () => false)).toBeNull();
    expect(activeTab(pane).content.kind).toBe("nightshift");
  });
  it("something else landing in place forgets what Nightshift held", () => {
    const ws = ws2();
    const pane = focusedPane(ws);
    land(ws, pane, { kind: "nightshift" }, "replace");
    land(ws, pane, chat("c"), "replace");
    expect(activeTab(pane).back).toBeUndefined();
    expect(takeBack(ws, () => true)).toBeNull();
  });
});
