import { describe, expect, it } from "vitest";
import {
  activate,
  activeTab,
  allTabs,
  close,
  closeFloating,
  dropChat,
  dropProject,
  emptyWorkspace,
  focusedPane,
  insertAt,
  isOwnSlot,
  keepFloating,
  keepFloatingBeside,
  land,
  liveTab,
  makeTab,
  move,
  openBeside,
  openFloating,
  parseContentDrag,
  reorder,
  sameContent,
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
    case "attachment":
      return c.name;
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

describe("reorder (backlog 195)", () => {
  it("a drop in its own slot — before it or after it — moves nothing and switches nothing", () => {
    const w = ws(chat("a"), chat("b"), chat("c"));
    const pane = w.panes[0];
    const b = pane.tabs[1].id;
    expect(isOwnSlot(w, b, pane.id, 1)).toBe(true);
    expect(isOwnSlot(w, b, pane.id, 2)).toBe(true);
    expect(isOwnSlot(w, b, pane.id, 0)).toBe(false);
    expect(reorder(w, b, 1)).toBe(false);
    expect(move(w, b, pane.id, 2)).toBe(false);
    expect(order(w)).toEqual([["a", "b", "c"]]);
    expect(activeTab(pane).content).toEqual(chat("a"));
  });

  it("reordering another tab leaves the active tab and the focused pane alone", () => {
    const w = ws(chat("a"), chat("b"), chat("c"));
    const pane = w.panes[0];
    expect(reorder(w, pane.tabs[2].id, 0)).toBe(true);
    expect(order(w)).toEqual([["c", "a", "b"]]);
    expect(activeTab(pane).content).toEqual(chat("a"));
    expect(w.focused).toBe(pane.id);
  });

  it("the open tab reorders and stays the open tab", () => {
    const w = ws(chat("a"), chat("b"), chat("c"));
    const pane = w.panes[0];
    const a = pane.tabs[0].id;
    expect(move(w, a, pane.id, 2)).toBe(true);
    expect(order(w)).toEqual([["b", "a", "c"]]);
    expect(pane.active).toBe(a);
    expect(reorder(w, a, 3)).toBe(true);
    expect(order(w)).toEqual([["b", "c", "a"]]);
    expect(pane.active).toBe(a);
  });

  it("the active tab moved into the other pane takes the focus with it", () => {
    const w = ws(chat("a"), chat("b"), chat("c"));
    split(w, w.panes[0].tabs[2].id, "right");
    const [left, right] = w.panes;
    activate(w, left.tabs[0].id);
    const a = left.tabs[0].id;
    expect(move(w, a, right.id, 0)).toBe(true);
    expect(order(w)).toEqual([["b"], ["a", "c"]]);
    expect(right.active).toBe(a);
    expect(w.focused).toBe(right.id);
    expect(activeTab(left).content).toEqual(chat("b"));
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

describe("the floating slot (backlog 145)", () => {
  const img: TabContent = { kind: "attachment", session: "a", turn: 3, index: 0, media: "image", name: "image" };
  const pdf: TabContent = { kind: "attachment", session: "a", turn: 3, index: 1, media: "document", name: "paper.pdf" };

  it("holds one tab at most; opening another replaces it; it is in no strip", () => {
    const w = ws(chat("a"));
    const t1 = openFloating(w, img);
    expect(w.floating).toBe(t1);
    const t2 = openFloating(w, pdf);
    expect(w.floating).toBe(t2);
    expect(allTabs(w).map((t) => t.id)).not.toContain(t2.id);
    expect(closeFloating(w)).toBe(t2);
    expect(w.floating).toBeNull();
    expect(closeFloating(w)).toBeNull();
  });

  it("kept onto a strip: an ordinary tab at the index, the slot empty", () => {
    const w = ws(chat("a"), chat("b"));
    const f = openFloating(w, pdf);
    const kept = keepFloating(w, w.panes[0], 1);
    expect(kept).toBe(f);
    expect(w.floating).toBeNull();
    expect(order(w)).toEqual([["a", "paper.pdf", "b"]]);
    expect(activeTab(w.panes[0]).id).toBe(f.id);
    // The same attachment again: the tab there is activated, not doubled.
    openFloating(w, pdf);
    expect(keepFloating(w, w.panes[0], 0)?.id).toBe(f.id);
    expect(order(w)).toEqual([["a", "paper.pdf", "b"]]);
    expect(keepFloating(w, w.panes[0], 0)).toBeNull();
  });

  it("kept beside: a second pane with one pane, the far pane's end with two", () => {
    const w = ws(chat("a"));
    const f = openFloating(w, img);
    expect(keepFloatingBeside(w, "right")).toBe(f);
    expect(order(w)).toEqual([["a"], ["image"]]);
    expect(w.focused).toBe(w.panes[1].id);
    const g = openFloating(w, pdf);
    expect(keepFloatingBeside(w, "left")).toBe(g);
    expect(order(w)).toEqual([["a", "paper.pdf"], ["image"]]);
    expect(w.floating).toBeNull();
  });

  it("a deleted chat takes its attachment tabs and the floating one", () => {
    const w = ws(chat("a"), img, chat("b"));
    openFloating(w, pdf);
    dropChat(w, "a");
    expect(order(w)).toEqual([["b"]]);
    expect(w.floating).toBeNull();
  });

  it("titles by the attachment's name and parses the descriptor", () => {
    expect(tabTitle(pdf, [])).toBe("paper.pdf");
    expect(parseContentDrag(JSON.stringify(img))).toEqual(img);
    expect(parseContentDrag(JSON.stringify({ kind: "attachment", session: "a", turn: 1, index: 0, media: "gif" }))).toBeNull();
    expect(parseContentDrag(JSON.stringify({ kind: "attachment", session: "a", turn: "1", index: 0, media: "image" }))).toBeNull();
  });
});

describe("a subagent's transcript as a tab (backlog 152)", () => {
  const sub: TabContent = { kind: "subagent", session: "a", toolUseId: "toolu_1", name: "Survey the crate" };

  it("is keyed by chat and call, titled by the task, and goes with its chat", () => {
    expect(tabTitle(sub, [])).toBe("Agent · Survey the crate");
    expect(sameContent(sub, { ...sub, name: "renamed" })).toBe(true);
    expect(sameContent(sub, { ...sub, toolUseId: "toolu_2" })).toBe(false);
    expect(sameContent(sub, { ...sub, session: "b" })).toBe(false);
    const w = ws(chat("a"), chat("b"));
    land(w, w.panes[0], sub, "new");
    expect(order(w)).toEqual([["a", "subagent", "b"]]);
    // The same agent again lands on its tab rather than a second one.
    land(w, w.panes[0], { ...sub, name: "renamed" }, "new");
    expect(order(w)).toEqual([["a", "subagent", "b"]]);
    dropChat(w, "a");
    expect(order(w)).toEqual([["b"]]);
  });

  it("parses the descriptor and refuses one without its call", () => {
    expect(parseContentDrag(JSON.stringify(sub))).toEqual(sub);
    expect(parseContentDrag(JSON.stringify({ kind: "subagent", session: "a", toolUseId: "t" }))).toEqual({
      kind: "subagent",
      session: "a",
      toolUseId: "t",
      name: "subagent",
    });
    expect(parseContentDrag(JSON.stringify({ kind: "subagent", session: "a" }))).toBeNull();
  });
});

describe("web tabs (nightshift backlog 172)", () => {
  it("opens beside the chat, keeps the chat's tab, and finds the page again by address", async () => {
    const t = await import("./tabs");
    const ws = t.emptyWorkspace();
    const pane = t.focusedPane(ws);
    const chat = t.activeTab(pane);
    chat.content = { kind: "chat", session: "s1" };
    const page = t.land(ws, pane, { kind: "web", url: "https://example.com/a" }, "new");
    expect(pane.tabs.map((x) => x.content.kind)).toEqual(["chat", "web"]);
    expect(pane.active).toBe(page.id);
    expect(t.findAnywhere(ws, { kind: "web", url: "https://example.com/a" })?.id).toBe(page.id);
    expect(t.split(ws, page.id, "right")).toBe(true);
    expect(ws.panes.map((p) => t.activeTab(p).content.kind)).toEqual(["chat", "web"]);
  });
  it("is titled by the page, else its host, and carries only http(s) in a drag", async () => {
    const t = await import("./tabs");
    expect(t.tabTitle({ kind: "web", url: "https://arxiv.org/abs/1" }, [])).toBe("arxiv.org");
    expect(t.tabTitle({ kind: "web", url: "https://arxiv.org/abs/1", title: " A paper " }, [])).toBe("A paper");
    expect(t.parseContentDrag(JSON.stringify({ kind: "web", url: "https://a.b/" }))).toEqual({ kind: "web", url: "https://a.b/" });
    expect(t.parseContentDrag(JSON.stringify({ kind: "web", url: "tauri://localhost/" }))).toBeNull();
    expect(t.parseContentDrag(JSON.stringify({ kind: "web", url: "javascript:alert(1)" }))).toBeNull();
  });
});

describe("aside threads, several per chat (backlog 176)", () => {
  it("two threads of one chat are two tabs; the same thread twice is one", () => {
    const w = ws(chat("a"));
    const pane = w.panes[0]!;
    const one: TabContent = { kind: "aside", session: "a", thread: 1 };
    const two: TabContent = { kind: "aside", session: "a", thread: 2 };
    land(w, pane, one, "new");
    land(w, pane, two, "new");
    expect(allTabs(w).filter((t) => t.content.kind === "aside").length).toBe(2);
    land(w, pane, { kind: "aside", session: "a", thread: 1 }, "new");
    expect(allTabs(w).filter((t) => t.content.kind === "aside").length).toBe(2);
    expect(sameContent(one, two)).toBe(false);
  });

  it("a dragged descriptor keeps its thread", () => {
    expect(parseContentDrag(JSON.stringify({ kind: "aside", session: "a", thread: 3 }))).toEqual({
      kind: "aside",
      session: "a",
      thread: 3,
    });
    expect(parseContentDrag(JSON.stringify({ kind: "aside", session: "a" }))).toEqual({ kind: "aside", session: "a" });
  });
});
