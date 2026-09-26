import { describe, expect, it } from "vitest";
import { originsOf, parseOpen, sidebarRows, toggled } from "./forkTree";
import type { SessionMeta } from "./types";

function meta(id: string, parent?: string): SessionMeta {
  return {
    id,
    path: `/x/${id}.jsonl`,
    modified: "2026-09-25T00:00:00Z",
    user_turns: 1,
    first_user: id,
    title: null,
    ...(parent ? { forked_from: { session: parent, index: 2 } } : {}),
  };
}

const ids = (rows: { meta: SessionMeta; depth: number }[]) =>
  rows.map((r) => `${"-".repeat(r.depth)}${r.meta.id}`);

describe("sidebarRows (backlog 207)", () => {
  it("leaves a list with no forks exactly as it was", () => {
    const list = [meta("a"), meta("b"), meta("c")];
    const rows = sidebarRows(list, new Set());
    expect(ids(rows)).toEqual(["a", "b", "c"]);
    expect(rows.every((r) => r.forks === 0 && r.depth === 0)).toBe(true);
  });

  it("hides a fork under its origin, closed by default, with a count", () => {
    const list = [meta("f", "s8"), meta("s9"), meta("s8")];
    const rows = sidebarRows(list, new Set());
    expect(ids(rows)).toEqual(["s9", "s8"]);
    expect(rows.find((r) => r.meta.id === "s8")!.forks).toBe(1);
  });

  it("lists the forks right after an open origin, indented, in list order", () => {
    const list = [meta("f2", "p"), meta("x"), meta("f1", "p"), meta("p")];
    expect(ids(sidebarRows(list, new Set(["p"])))).toEqual(["x", "p", "-f2", "-f1"]);
  });

  it("keeps a chat whose parent is not listed (deleted, other project) top-level", () => {
    const list = [meta("orphan", "gone"), meta("a")];
    const rows = sidebarRows(list, new Set());
    expect(ids(rows)).toEqual(["orphan", "a"]);
    expect(rows[0].forks).toBe(0);
  });

  it("flattens a fork of a fork under the topmost origin and marks it", () => {
    const list = [meta("g", "f"), meta("f", "r"), meta("r")];
    expect(originsOf(list).get("g")).toBe("r");
    const rows = sidebarRows(list, new Set(["r"]));
    expect(ids(rows)).toEqual(["r", "-g", "-f"]);
    expect(rows[0].forks).toBe(2);
    expect(rows.find((r) => r.meta.id === "g")!.fromOther).toBe(true);
    expect(rows.find((r) => r.meta.id === "f")!.fromOther).toBe(false);
  });

  it("stops at a missing link: a fork of a deleted fork groups nowhere", () => {
    const list = [meta("g", "deleted"), meta("r")];
    expect(ids(sidebarRows(list, new Set(["r"])))).toEqual(["g", "r"]);
  });

  it("shows a closed group when the active chat is one of its forks", () => {
    const list = [meta("f", "p"), meta("p")];
    const revealed = sidebarRows(list, new Set(), "f");
    expect(ids(revealed)).toEqual(["p", "-f"]);
    expect(revealed[0].expanded).toBe(true);
    const closed = sidebarRows(list, new Set(), "p");
    expect(ids(closed)).toEqual(["p"]);
    expect(closed[0].expanded).toBe(false);
  });

  it("survives a cycle by leaving its chats top-level", () => {
    const list = [meta("a", "b"), meta("b", "a")];
    expect(ids(sidebarRows(list, new Set()))).toEqual(["a", "b"]);
  });
});

describe("the open set", () => {
  it("parses what it stores and nothing else", () => {
    expect([...parseOpen('["a","b"]')]).toEqual(["a", "b"]);
    expect(parseOpen(null).size).toBe(0);
    expect(parseOpen("not json").size).toBe(0);
    expect([...parseOpen('["a",3,null]')]).toEqual(["a"]);
    expect(parseOpen('{"a":1}').size).toBe(0);
  });
  it("toggles without touching the old set", () => {
    const a = new Set(["x"]);
    expect([...toggled(a, "y")].sort()).toEqual(["x", "y"]);
    expect([...toggled(a, "x")]).toEqual([]);
    expect([...a]).toEqual(["x"]);
  });
});
