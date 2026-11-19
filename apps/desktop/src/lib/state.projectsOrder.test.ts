import { beforeEach, describe, expect, it, vi } from "vitest";
import { app, refreshProjects } from "./state.svelte";
import type { ProjectInfo } from "./types";

/**
 * Item 865: the launch reads the project list beside the reopen, and the
 * reopen re-reads it behind itself — two reads in flight. The older one
 * (the launch's, slow on a cold disk) must not land last and put back the
 * list from before the reopen bumped its project's last-opened.
 */
const { row, answers } = vi.hoisted(() => ({
  row: (id: string): ProjectInfo =>
    ({ id, name: id, root: `/p/${id}`, notes_dir: `/p/${id}/n`, notes: 0, chats: 0, exists: true }) as ProjectInfo,
  answers: [] as Array<(rows: ProjectInfo[]) => void>,
}));

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  listProjects: vi.fn(() => new Promise<ProjectInfo[]>((resolve) => answers.push(resolve))),
}));

describe("overlapping project-list reads (item 865)", () => {
  beforeEach(() => {
    answers.length = 0;
    app.projects = [];
    app.project = null;
  });

  it("drops a read that started before the one already applied", async () => {
    const older = refreshProjects();
    const newer = refreshProjects();
    answers[1]([row("b"), row("a")]);
    await newer;
    expect(app.projects.map((p) => p.id)).toEqual(["b", "a"]);
    answers[0]([row("a"), row("b")]);
    await older;
    expect(app.projects.map((p) => p.id)).toEqual(["b", "a"]);
  });

  it("applies reads that land in the order they were asked", async () => {
    const first = refreshProjects();
    const second = refreshProjects();
    answers[0]([row("a")]);
    await first;
    expect(app.projects.map((p) => p.id)).toEqual(["a"]);
    answers[1]([row("a"), row("c")]);
    await second;
    expect(app.projects.map((p) => p.id)).toEqual(["a", "c"]);
  });
});
