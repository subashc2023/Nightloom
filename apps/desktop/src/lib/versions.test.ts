import { describe, expect, it } from "vitest";
import { sidebarRows } from "./forkTree";
import {
  canMakeMain,
  forkInfo,
  lineageForks,
  makeMain,
  mainOf,
  parseVersions,
  sidebarSessions,
  versionPlace,
  versionsAt,
  type ForkInfo,
  type VersionMap,
} from "./versions";
import type { SessionEvent, SessionMeta } from "./types";

function meta(id: string, parent?: string, index = 3, title: string | null = null, reason?: string): SessionMeta {
  return {
    id,
    path: `/x/${id}.jsonl`,
    modified: "2026-10-04T00:00:00Z",
    user_turns: 2,
    first_user: id,
    title,
    ...(parent ? { forked_from: { session: parent, index, ...(reason ? { reason } : {}) } } : {}),
  };
}

const ids = (rows: { meta: SessionMeta; depth: number }[]) =>
  rows.map((r) => `${"-".repeat(r.depth)}${r.meta.id}`);
const listed = (l: SessionMeta[]) => new Set(l.map((s) => s.id));

describe("Make main (item 299)", () => {
  it("is offered on an edit fork, not on a top-level chat or a hand-off continuation", () => {
    const list = [meta("f", "o"), meta("h", "o", 9, null, "handoff"), meta("o")];
    expect(canMakeMain(list, {}, "f")).toBe(true);
    expect(canMakeMain(list, {}, "o")).toBe(false);
    expect(canMakeMain(list, {}, "h")).toBe(false);
    expect(canMakeMain(list, {}, "gone")).toBe(false);
  });

  // Blocker 1062 (default): the row stands where the newest of its group
  // stands — the list is newest-first, so the chat he goes on using rises
  // as the original's row would have.
  it("puts the fork in the original's row and place; the original is no longer a row", () => {
    const list = [meta("x"), meta("y"), meta("o"), meta("f", "o"), meta("z")];
    expect(ids(sidebarRows(list, new Set(["o"])))).toEqual(["x", "y", "o", "-f", "z"]);
    const map = makeMain(list, {}, "f")!;
    expect(map).toEqual({ o: "f" });
    const rows = sidebarRows(sidebarSessions(list, map), new Set(["o", "f"]));
    expect(ids(rows)).toEqual(["x", "y", "f", "z"]);
    expect(rows[2].meta.forked_from).toBeUndefined(); // drawn top-level, no "from" line
    // the newest of the group sets the place: f listed above o, f there
    const newer = [meta("x"), meta("f", "o"), meta("y"), meta("o")];
    expect(ids(sidebarRows(sidebarSessions(newer, map), new Set()))).toEqual(["x", "f", "y"]);
    expect(canMakeMain(list, map, "f")).toBe(false); // it is main now
  });

  it("keeps the original's other forks, under the chat that took its place", () => {
    const list = [meta("f", "o"), meta("g", "o", 7), meta("o")];
    const map = makeMain(list, {}, "f")!;
    const rows = sidebarRows(sidebarSessions(list, map), new Set(["f"]));
    expect(ids(rows)).toEqual(["f", "-g"]);
    expect(rows[0].forks).toBe(1);
  });

  it("keeps a nested original's place under its own parent", () => {
    const list = [meta("f", "o"), meta("o", "p", 5), meta("p")];
    const map = makeMain(list, {}, "f")!;
    const rows = sidebarRows(sidebarSessions(list, map), new Set(["p"]));
    expect(ids(rows)).toEqual(["p", "-f"]);
    expect(rows[1].meta.forked_from?.session).toBe("p");
  });

  it("puts the original back by Make main on it (a hidden version)", () => {
    const list = [meta("f", "o"), meta("o")];
    const map = makeMain(list, {}, "f")!;
    expect(canMakeMain(list, map, "o")).toBe(true);
    const back = makeMain(list, map, "o")!;
    expect(back).toEqual({ f: "o" });
    expect(mainOf("f", back, listed(list))).toBe("o");
    expect(ids(sidebarRows(sidebarSessions(list, back), new Set(["o"])))).toEqual(["o"]);
    // the fork is a version now, reachable by the arrows, not an indented row
  });

  it("moves a whole group on a third version: a fork of the main chat made main", () => {
    const list = [meta("g", "f", 4), meta("f", "o"), meta("o")];
    const m1 = makeMain(list, {}, "f")!;
    const m2 = makeMain(list, m1, "g")!;
    expect(m2).toEqual({ o: "g", f: "g" });
    expect(ids(sidebarRows(sidebarSessions(list, m2), new Set()))).toEqual(["g"]);
  });

  it("brings the original back as a row when the chat that took its place is gone", () => {
    const list = [meta("o"), meta("x")];
    const map: VersionMap = { o: "f" }; // f deleted or trashed
    expect(mainOf("o", map, listed(list))).toBe("o");
    expect(ids(sidebarRows(sidebarSessions(list, map), new Set()))).toEqual(["o", "x"]);
  });

  it("returns the list untouched when nothing has been made main", () => {
    const list = [meta("f", "o"), meta("o")];
    expect(sidebarSessions(list, {})).toBe(list);
  });

  it("survives relaunch: the stored map parses back, junk reads as empty", () => {
    const list = [meta("f", "o"), meta("o")];
    const map = makeMain(list, {}, "f")!;
    expect(parseVersions(JSON.stringify(map))).toEqual(map);
    expect(parseVersions(null)).toEqual({});
    expect(parseVersions("[1,2]")).toEqual({});
    expect(parseVersions("{bad")).toEqual({});
    expect(parseVersions('{"a":"b","c":4}')).toEqual({ a: "b" });
  });
});

const at = (min: number) => `2026-10-04T10:${String(min).padStart(2, "0")}:00Z`;
function forkLog(created: number, carried: number[], own: number): SessionEvent[] {
  return [
    { event: "session_created", id: "x", at: at(created) },
    ...carried.map((m): SessionEvent => ({ event: "user_message", text: "old", at: at(m) })),
    { event: "user_message", text: "new", at: at(own) },
  ];
}

describe("versions under an edited message (item 299)", () => {
  it("finds a fork's own first message after its carried prefix", () => {
    expect(forkInfo(forkLog(30, [1, 2], 31))).toEqual({ cut: 3, created: at(30) });
    expect(forkInfo([{ event: "session_created", id: "x", at: at(5) }])).toEqual({ cut: null, created: at(5) });
    expect(forkInfo([])).toBeNull();
  });

  it("lists the forks in a chat's lineage, not its hand-offs or strangers", () => {
    const list = [meta("f", "o"), meta("g", "f"), meta("h", "o", 9, null, "handoff"), meta("o"), meta("x")];
    expect(lineageForks(list, "g").sort()).toEqual(["f", "g"]);
    expect(lineageForks(list, "x")).toEqual([]);
  });

  // o's message at 3 edited twice from o (f, g) and once more inside f (k):
  // four versions, the original first, the rest by birth.
  const list = [meta("k", "f", 3), meta("g", "o", 3), meta("f", "o", 3), meta("o"), meta("other", "o", 7)];
  const info = new Map<string, ForkInfo>([
    ["f", { cut: 3, created: at(10) }],
    ["g", { cut: 3, created: at(20) }],
    ["k", { cut: 4, created: at(30) }],
    ["other", { cut: 5, created: at(40) }],
  ]);

  it("gives 1/2 and 2/2 for one edit", () => {
    const two = [meta("f", "o", 3), meta("o")];
    const inf = new Map([["f", { cut: 3, created: at(10) }]]);
    expect(versionsAt(two, inf, "o", 3)).toEqual(["o", "f"]);
    expect(versionsAt(two, inf, "f", 3)).toEqual(["o", "f"]);
    expect(versionPlace(versionsAt(two, inf, "f", 3), "f")).toEqual({ n: 2, total: 2 });
    expect(versionsAt(two, inf, "o", 1)).toBeNull(); // another message: no arrows
  });

  it("counts 3+ versions, through forks of forks, from any of them", () => {
    // k forked from f at f's index 3 — f's own edited message — so it is
    // a version of the same message, reached through f.
    expect(versionsAt(list, info, "o", 3)).toEqual(["o", "f", "g", "k"]);
    expect(versionsAt(list, info, "k", 4)).toEqual(["o", "f", "g", "k"]);
    expect(versionPlace(versionsAt(list, info, "g", 3), "g")).toEqual({ n: 3, total: 4 });
    expect(versionPlace(versionsAt(list, info, "o", 3), "o")).toEqual({ n: 1, total: 4 });
  });

  it("keeps an edit of a different message out of the set", () => {
    expect(versionsAt(list, info, "other", 5)).toEqual(["o", "other"]);
    expect(versionsAt(list, info, "o", 3)).not.toContain("other");
  });

  it("draws no arrows for a fork whose own message has not landed", () => {
    const two = [meta("f", "o", 3), meta("o")];
    expect(versionsAt(two, new Map([["f", { cut: null, created: at(1) }]]), "o", 3)).toBeNull();
  });

  it("still lists a version made main and the original it replaced", () => {
    const two = [meta("f", "o", 3), meta("o")];
    const inf = new Map([["f", { cut: 3, created: at(10) }]]);
    // the map only moves rows; the arrows are the fork graph's
    void makeMain(two, {}, "f");
    expect(versionsAt(two, inf, "f", 3)).toEqual(["o", "f"]);
  });
});
