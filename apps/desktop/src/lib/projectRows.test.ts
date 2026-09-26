import { describe, expect, it } from "vitest";
import { withProject, withoutProject } from "./projectRows";
import type { ProjectInfo } from "./types";

const row = (id: string, name = id): ProjectInfo =>
  ({ id, name, root: `/p/${id}`, notes_dir: `/p/${id}/notes`, notes: 0, chats: 0, exists: true }) as ProjectInfo;

describe("project rows before the re-read (backlog 211)", () => {
  it("puts a new project first", () => {
    expect(withProject([row("a"), row("b")], row("c")).map((p) => p.id)).toEqual(["c", "a", "b"]);
  });

  it("replaces a project in place — a rename keeps its position", () => {
    const next = withProject([row("a"), row("b"), row("c")], row("b", "Renamed"));
    expect(next.map((p) => p.name)).toEqual(["a", "Renamed", "c"]);
  });

  it("drops a forgotten project", () => {
    expect(withoutProject([row("a"), row("b")], "a").map((p) => p.id)).toEqual(["b"]);
  });
});
