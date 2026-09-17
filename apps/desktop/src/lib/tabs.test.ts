import { describe, expect, it } from "vitest";
import {
  activate,
  activeTab,
  allTabs,
  close,
  dropChat,
  dropProject,
  emptyWorkspace,
  focusedPane,
  insertAt,
  land,
  liveTab,
  makeTab,
  move,
  openBeside,
  parseContentDrag,
  split,
  step,
  tabTitle,
  type TabContent,
  type Workspace,
} from "./tabs";

const chat = (session: string | null): TabContent => ({
  kind: "chat",
  session,
});
const note = (name: string): TabContent => ({
  kind: "note",
  scope: "project",
  name,
});
const nightshift: TabContent = { kind: "nightshift" };
const graph: TabContent = { kind: "graph" };

/** One pane with tabs of the given contents, the first active. */
function ws(...contents: TabContent[]): Workspace {
  const w = emptyWorkspace();
  const pane = w.panes[0];
  if (contents.length > 0) {
    pane.tabs = contents.map(makeTab);
    pane.active = pane.tabs[0].id;
  }
  return w;
}

/** A short name per tab: the chat's session (`new` unsent), the note's
 *  file, the project's id, the aside's chat, else the kind. */
function label(c: TabContent): string {
  switch (c.kind) {
    case "chat":
      return c.session ?? "new";
    case "note":
      return c.name;
    case "project":
      return `project:${c.id}`;
    case "aside":
      return `aside:${c.session}`;
    default:
      return c.kind;
  }
}
const order = (w: Workspace) =>
  w.panes.map((p) => p.tabs.map((t) => label(t.content)));

describe("the workspace", () => {
  it("opens with one pane holding one new-chat tab", () => {
    const w = emptyWorkspace();
    expect(w.panes).toHaveLength(1);
    expect(order(w)).toEqual([["new"]]);
    expect(w.focused).toBe(w.panes[0].id);
  });
});

describe("land", () => {
  it("replaces the active tab on a plain click (blocker 140)", () => {
    const w = ws(chat("a"), chat("b"));
    const pane = w.panes[0];
    land(w, pane, chat("c"), "replace");
    expect(order(w)).toEqual([["c", "b"]]);
    expect(activeTab(pane).content).toEqual(chat("c"));
  });

  it("inserts after the active tab on ⌘-click", () => {
    const w = ws(chat("a"), chat("b"));
    const pane = w.panes[0];
    land(w, pane, chat("c"), "new");
    expect(order(w)).toEqual([["a", "c", "b"]]);
    expect(activeTab(pane).content).toEqual(chat("c"));
  });

  it("activates an existing tab of the same content rather than doubling it", () => {
    const w = ws(chat("a"), note("plan.md"));
    const pane = w.panes[0];
    const t = land(w, pane, note("plan.md"), "new");
    expect(order(w)).toEqual([["a", "plan.md"]]);
    expect(pane.active).toBe(t.id);
  });

  it("a second New chat lands on the pane's new-chat tab", () => {
    const w = ws(chat(null), chat("a"));
    const pane = w.panes[0];
    activate(w, pane.tabs[1].id);
    land(w, pane, chat(null), "new");
    expect(order(w)).toEqual([["new", "a"]]);
    expect(pane.active).toBe(pane.tabs[0].id);
  });

  it("the first message retargets the new-chat tab to its session", () => {
    const w = ws(chat(null));
    land(w, w.panes[0], chat("fresh"), "replace");
    expect(order(w)).toEqual([["fresh"]]);
  });
});

describe("close", () => {
  it("lands on the right neighbour, else the left", () => {
    const w = ws(chat("a"), chat("b"), chat("c"));
    const pane = w.panes[0];
    activate(w, pane.tabs[1].id);
    let r = close(w, pane.tabs[1].id);
    expect(order(w)).toEqual([["a", "c"]]);
    expect(r.show?.content).toEqual(chat("c"));
    r = close(w, pane.tabs[1].id);
    expect(order(w)).toEqual([["a"]]);
    expect(r.show?.content).toEqual(chat("a"));
  });

  it("closing a background tab shows nothing new", () => {
    const w = ws(chat("a"), chat("b"));
    const r = close(w, w.panes[0].tabs[1].id);
    expect(r.show).toBeUndefined();
    expect(order(w)).toEqual([["a"]]);
  });

  it("the last tab of the last pane becomes a new-chat tab", () => {
    const w = ws(chat("a"));
    const r = close(w, w.panes[0].tabs[0].id);
    expect(order(w)).toEqual([["new"]]);
    expect(r.show?.content).toEqual(chat(null));
  });

  it("the last tab of one of two panes closes the pane", () => {
    const w = ws(chat("a"), chat("b"));
    split(w, w.panes[0].tabs[1].id, "right");
    expect(w.panes).toHaveLength(2);
    const right = w.panes[1];
    const r = close(w, right.tabs[0].id);
    expect(w.panes).toHaveLength(1);
    expect(r.paneRemoved?.id).toBe(right.id);
    expect(w.focused).toBe(w.panes[0].id);
    expect(r.show?.content).toEqual(chat("a"));
  });
});

describe("step", () => {
  it("walks both panes in order and wraps", () => {
    const w = ws(chat("a"), chat("b"), note("n.md"));
    split(w, w.panes[0].tabs[2].id, "right");
    activate(w, w.panes[0].tabs[0].id);
    expect(step(w, 1)?.content).toEqual(chat("b"));
    activate(w, w.panes[0].tabs[1].id);
    expect(step(w, 1)?.content).toEqual(note("n.md"));
    activate(w, w.panes[1].tabs[0].id);
    expect(step(w, 1)?.content).toEqual(chat("a"));
    expect(step(w, -1)?.content).toEqual(chat("b"));
  });

  it("is null with one tab", () => {
    expect(step(ws(chat("a")), 1)).toBeNull();
  });
});

describe("move", () => {
  it("reorders within a strip, counting the drop from the shortened list", () => {
    const w = ws(chat("a"), chat("b"), chat("c"));
    const pane = w.panes[0];
    move(w, pane.tabs[0].id, pane.id, 3);
    expect(order(w)).toEqual([["b", "c", "a"]]);
    move(w, pane.tabs[2].id, pane.id, 0);
    expect(order(w)).toEqual([["a", "b", "c"]]);
  });

  it("moves into the other pane and closes an emptied source", () => {
    const w = ws(chat("a"), chat("b"));
    split(w, w.panes[0].tabs[1].id, "right");
    const [left, right] = w.panes;
    move(w, left.tabs[0].id, right.id, 0);
    expect(w.panes).toHaveLength(1);
    expect(order(w)).toEqual([["a", "b"]]);
    expect(activeTab(w.panes[0]).content).toEqual(chat("a"));
  });
});

describe("split", () => {
  it("refuses a third pane and a pane's only tab", () => {
    const w = ws(chat("a"));
    expect(split(w, w.panes[0].tabs[0].id, "right")).toBe(false);
    const w2 = ws(chat("a"), chat("b"), chat("c"));
    expect(split(w2, w2.panes[0].tabs[2].id, "left")).toBe(true);
    expect(order(w2)).toEqual([["c"], ["a", "b"]]);
    expect(split(w2, w2.panes[1].tabs[1].id, "right")).toBe(false);
  });

  it("openBeside makes the second pane, then lands in it", () => {
    const w = ws(chat("a"));
    openBeside(w, note("n.md"));
    expect(order(w)).toEqual([["a"], ["n.md"]]);
    expect(focusedPane(w).id).toBe(w.panes[1].id);
    activate(w, w.panes[0].tabs[0].id);
    openBeside(w, chat("b"));
    expect(order(w)).toEqual([["a"], ["n.md", "b"]]);
  });
});

describe("liveTab and dropChat", () => {
  it("prefers the focused pane's active tab, then any tab of the session", () => {
    const w = ws(chat("a"), chat("b"));
    split(w, w.panes[0].tabs[1].id, "right");
    activate(w, w.panes[0].tabs[0].id);
    expect(liveTab(w, "b")?.content).toEqual(chat("b"));
    expect(liveTab(w, "a")?.id).toBe(w.panes[0].tabs[0].id);
    expect(liveTab(w, "zzz")).toBeUndefined();
  });

  it("a deleted chat's tabs go, in both panes", () => {
    const w = ws(chat("a"), chat("b"));
    openBeside(w, chat("a"));
    dropChat(w, "a");
    expect(order(w)).toEqual([["b"]]);
    expect(allTabs(w)).toHaveLength(1);
  });
});

describe("tabTitle", () => {
  it("names the chat as the sidebar does, the note by its file", () => {
    const sessions = [
      { id: "abcdef123456", title: null, first_user: "hello there" },
    ];
    expect(tabTitle(chat("abcdef123456"), sessions)).toBe("hello there");
    expect(tabTitle(chat("nope-nope-nope"), sessions)).toBe("nope-nop");
    expect(tabTitle(chat(null), sessions)).toBe("New chat");
    expect(tabTitle(note("plan.md"), sessions)).toBe("plan.md");
  });

  it("names the whole-centre pages, a project by its name, an aside by its chat (backlog 140)", () => {
    const sessions = [
      { id: "abcdef123456", title: "q5 sweep", first_user: null },
    ];
    const projects = [{ id: "p1", name: "Nightloom" }];
    expect(tabTitle(nightshift, sessions)).toBe("Nightshift");
    expect(tabTitle(graph, sessions)).toBe("Graph");
    expect(tabTitle({ kind: "new-project" }, sessions)).toBe("New project");
    expect(tabTitle({ kind: "project", id: "p1" }, sessions, projects)).toBe(
      "Nightloom",
    );
    expect(tabTitle({ kind: "project", id: "gone" }, sessions, projects)).toBe(
      "Project",
    );
    expect(tabTitle({ kind: "aside", session: "abcdef123456" }, sessions)).toBe(
      "Aside · q5 sweep",
    );
  });
});

// Backlog 140 (2026-09-17): the whole-centre pages as tabs, one each.
describe("singletons", () => {
  it("a second Nightshift lands on the one there is, in either pane", () => {
    const w = ws(chat("a"), chat("b"));
    land(w, w.panes[0], nightshift, "new");
    expect(order(w)).toEqual([["a", "nightshift", "b"]]);
    split(w, w.panes[0].tabs[2].id, "right");
    // From the right pane, a plain click on Nightshift: no second tab —
    // the left pane's is activated and focused.
    land(w, w.panes[1], nightshift, "replace");
    expect(order(w)).toEqual([["a", "nightshift"], ["b"]]);
    expect(w.focused).toBe(w.panes[0].id);
    expect(activeTab(w.panes[0]).content).toEqual(nightshift);
    // Open beside does the same.
    w.focused = w.panes[1].id;
    openBeside(w, nightshift);
    expect(order(w)).toEqual([["a", "nightshift"], ["b"]]);
  });

  it("the graph replaces the active tab on a plain click, like a chat", () => {
    const w = ws(chat("a"));
    land(w, w.panes[0], graph, "replace");
    expect(order(w)).toEqual([["graph"]]);
    land(w, w.panes[0], chat("b"), "replace");
    expect(order(w)).toEqual([["b"]]);
  });
});

describe("drops from outside (backlog 140 pass 2)", () => {
  it("a descriptor dropped on a strip is a new tab at that index, once", () => {
    const w = ws(chat("a"), chat("b"));
    const t = insertAt(w, w.panes[0], note("plan.md"), 1);
    expect(order(w)).toEqual([["a", "plan.md", "b"]]);
    expect(w.panes[0].active).toBe(t.id);
    // The same note again: the tab there is, not a second.
    insertAt(w, w.panes[0], note("plan.md"), 0);
    expect(order(w)).toEqual([["a", "plan.md", "b"]]);
    // A project card and an aside are contents too.
    insertAt(w, w.panes[0], { kind: "project", id: "p1" }, 9);
    insertAt(w, w.panes[0], { kind: "aside", session: "a" }, 0);
    expect(order(w)).toEqual([["aside:a", "a", "plan.md", "b", "project:p1"]]);
  });

  it("a deleted chat takes its aside's tab; a forgotten project its card", () => {
    const w = ws(
      chat("a"),
      { kind: "aside", session: "a" },
      { kind: "project", id: "p1" },
      chat("b"),
    );
    dropChat(w, "a");
    expect(order(w)).toEqual([["project:p1", "b"]]);
    dropProject(w, "p1");
    expect(order(w)).toEqual([["b"]]);
  });

  it("parses the drag's descriptor and refuses anything else", () => {
    expect(parseContentDrag(JSON.stringify(chat("a")))).toEqual(chat("a"));
    expect(parseContentDrag(JSON.stringify(note("x.md")))).toEqual(
      note("x.md"),
    );
    expect(parseContentDrag(JSON.stringify(nightshift))).toEqual(nightshift);
    expect(
      parseContentDrag(JSON.stringify({ kind: "project", id: "p" })),
    ).toEqual({ kind: "project", id: "p" });
    expect(
      parseContentDrag(JSON.stringify({ kind: "note", scope: "project" })),
    ).toBeNull();
    expect(parseContentDrag("file:///etc/passwd")).toBeNull();
    expect(
      parseContentDrag(JSON.stringify({ kind: "shell", cmd: "rm" })),
    ).toBeNull();
    expect(parseContentDrag("")).toBeNull();
  });
});
