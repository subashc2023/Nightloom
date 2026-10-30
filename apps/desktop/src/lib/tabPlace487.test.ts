import { beforeEach, describe, expect, it } from "vitest";
import { KEEP_PER_PANE, isKeptKind, nextKept } from "./keptTabs.svelte";
import {
  atPath,
  pathOf,
  placeKey,
  recallPlaces,
  rememberPlace,
  resetPlaces,
} from "./tabPlace";

// Item 487: every tab keeps its place across a switch. The DOM side is measured in
// notes/runner-design/487-harness (WebKit); these pin the bookkeeping.

describe("which tabs stay mounted (keptTabs)", () => {
  it("keeps the note and the read-only views, not the chat, aside, web or singleton pages", () => {
    expect(isKeptKind({ kind: "note", scope: "project", name: "a.md" })).toBe(
      true,
    );
    expect(isKeptKind({ kind: "file", path: "/a.pdf" })).toBe(true);
    expect(isKeptKind({ kind: "thread", slug: "s" })).toBe(true);
    expect(
      isKeptKind({ kind: "subagent", session: "c", toolUseId: "t", name: "n" }),
    ).toBe(true);
    expect(
      isKeptKind({
        kind: "attachment",
        session: "c",
        turn: 1,
        index: 0,
        media: "document",
        name: "p.pdf",
      }),
    ).toBe(true);
    // A chip in a message box only ever floats.
    expect(
      isKeptKind({
        kind: "attachment",
        session: "c",
        turn: 0,
        index: 0,
        media: "image",
        name: "i",
        draft: { key: "k", chip: 1 },
      }),
    ).toBe(false);
    for (const c of [
      { kind: "chat", session: "c" },
      { kind: "aside", session: "c" },
      { kind: "web", url: "https://x" },
      { kind: "nightshift" },
      { kind: "graph" },
      { kind: "new-project" },
      { kind: "project", id: "p" },
    ] as const)
      expect(isKeptKind(c as never)).toBe(false);
  });

  it("adds the tab in front, keeps first-shown order, and drops tabs no longer in the pane", () => {
    let l = nextKept([], new Set(["a", "b", "c"]), "a", 1);
    l = nextKept(l, new Set(["a", "b", "c"]), "b", 2);
    l = nextKept(l, new Set(["a", "b", "c"]), "a", 3);
    // Coming back to "a" does not move it (moving a mounted <embed> reloads the PDF).
    expect(l.map((e) => e.id)).toEqual(["a", "b"]);
    l = nextKept(l, new Set(["b", "c"]), "c", 4);
    expect(l.map((e) => e.id)).toEqual(["b", "c"]);
    // A chat in front (not a kept kind) leaves the list as it is.
    expect(
      nextKept(l, new Set(["b", "c", "x"]), null, 5).map((e) => e.id),
    ).toEqual(["b", "c"]);
  });

  it("drops the least recently shown past the cap, never the one in front", () => {
    const ids = Array.from({ length: KEEP_PER_PANE + 2 }, (_, i) => `t${i}`);
    const live = new Set(ids);
    let l = nextKept([], live, "t0", 0);
    for (let i = 1; i < ids.length; i++) l = nextKept(l, live, ids[i], i);
    expect(l).toHaveLength(KEEP_PER_PANE);
    expect(l.map((e) => e.id)).toEqual(ids.slice(2));
    // t2 seen again, then a new one: t3 (now the oldest) goes, t2 stays.
    l = nextKept(l, live, "t2", 100);
    l = nextKept(l, new Set([...ids, "n"]), "n", 101);
    expect(l.map((e) => e.id)).toEqual(["t2", "t4", "t5", "t6", "t7", "n"]);
  });
});

describe("a view's scroll by what the tab shows (tabPlace)", () => {
  beforeEach(() => resetPlaces());

  it("keys files, attachments, threads, subagents and the scrolling singletons; not chats, asides or notes", () => {
    expect(placeKey({ kind: "file", path: "/w/a.rs" })).toBe("file:/w/a.rs");
    expect(placeKey({ kind: "thread", slug: "s" })).toBe("thread:s");
    expect(placeKey({ kind: "nightshift" })).toBe("nightshift");
    expect(placeKey({ kind: "new-project" })).toBe("new-project");
    expect(
      placeKey({
        kind: "attachment",
        session: "c",
        turn: 3,
        index: 1,
        media: "image",
        name: "x",
      }),
    ).toBe("attachment:c:3:image:1");
    expect(placeKey({ kind: "chat", session: "c" })).toBeNull();
    expect(placeKey({ kind: "aside", session: "c" })).toBeNull();
    expect(
      placeKey({ kind: "note", scope: "project", name: "a.md" }),
    ).toBeNull();
  });

  it("remembers per element path, and forgets a path scrolled back to the top", () => {
    rememberPlace("file:/a", "1", { top: 900, left: 0 });
    rememberPlace("file:/a", "2/0", { top: 40, left: 12 });
    expect([...recallPlaces("file:/a")]).toEqual([
      ["1", { top: 900, left: 0 }],
      ["2/0", { top: 40, left: 12 }],
    ]);
    rememberPlace("file:/a", "1", { top: 0, left: 0 });
    expect([...recallPlaces("file:/a").keys()]).toEqual(["2/0"]);
    expect(recallPlaces("file:/b").size).toBe(0);
  });

  it("walks an element's path of child indices there and back", () => {
    type N = { parentElement: N | null; children: N[] };
    const node = (parent: N | null): N => {
      const n: N = { parentElement: parent, children: [] };
      parent?.children.push(n);
      return n;
    };
    const root = node(null);
    node(root);
    const b = node(root);
    node(b);
    const target = node(b);
    const el = (n: N) => n as unknown as Element;
    expect(pathOf(el(root), el(target))).toBe("1/1");
    expect(atPath(el(root), "1/1")).toBe(target);
    expect(pathOf(el(root), el(root))).toBe("");
    expect(atPath(el(root), "4")).toBeNull();
    expect(pathOf(el(b), el(node(null)))).toBeNull();
  });
});
