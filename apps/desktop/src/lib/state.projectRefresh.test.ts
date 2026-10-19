import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  app,
  createNewProject,
  forgetProject,
  importFromClaude,
  openProjectFolder,
  renameProject,
  showNewProject,
  useKnowledgeDir,
  useProject,
} from "./state.svelte";
import * as tabs from "./tabs";
import { REFRESH_LIMIT_MS } from "./afterWrite";
import type { ProjectInfo } from "./types";

/**
 * Backlog 211's leftovers (2026-09-26): the project writes acknowledge at
 * once and re-read in the background under `REFRESH_LIMIT_MS`, as Save
 * has since d08de65. Every re-read here hangs — the 2026-09-25 shape, a
 * listing stuck on an iCloud folder — and each path must still finish.
 */
const { row, hang } = vi.hoisted(() => ({
  row: (id: string, name = id): ProjectInfo =>
    ({ id, name, root: `/p/${id}`, notes_dir: `/p/${id}/n`, notes: 0, chats: 0, exists: true }) as ProjectInfo,
  hang: () => new Promise<never>(() => {}),
}));

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  // The re-reads: never answer.
  listProjects: vi.fn(hang),
  listSessions: vi.fn(hang),
  listNotes: vi.fn(hang),
  projectsFolderInfo: vi.fn(hang),
  // The writes: answer at once.
  newProject: vi.fn(async (name: string) => row("new", name)),
  createProject: vi.fn(async () => row("picked", "Picked")),
  pickFolder: vi.fn(async () => "/somewhere/picked"),
  pickExport: vi.fn(async () => "/somewhere/export.zip"),
  importClaude: vi.fn(async () => ({ summary: "2 projects", needs_condensing: [], warnings: [] })),
  openProject: vi.fn(async (id: string) => row(id)),
  closeProject: vi.fn(async () => null),
  newSession: vi.fn(async () => ({ mode: "normal", kind: "build" })),
  renameProject: vi.fn(async (id: string, name: string) => row(id, name)),
  forgetProject: vi.fn(async () => null),
  setKnowledgeDir: vi.fn(async (dir: string | null) => ({ dir: dir ?? "/vault", default: dir === null })),
}));

/** Settle `p` or fail: the promise must end within the refresh limit. */
async function endsWithinLimit<T>(p: Promise<T>): Promise<T> {
  let done = false;
  let value: T | undefined;
  void p.then((v) => {
    done = true;
    value = v;
  });
  await vi.advanceTimersByTimeAsync(REFRESH_LIMIT_MS + 50);
  expect(done).toBe(true);
  return value as T;
}

describe("project writes acknowledge before the re-read (backlog 211)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    app.busy = false;
    app.connecting = false;
    app.connection = null;
    // A provider draft with no provider: `applyDraft` has nothing to connect.
    app.draft.engine = "provider";
    app.draft.provider = "";
    app.projects = [row("a"), row("b")];
    app.project = null;
    app.view = "chat";
    app.toasts = [];
  });
  afterEach(() => vi.useRealTimers());

  it("Create closes the form and shows the row with the list still hanging", async () => {
    app.view = "new-project";
    app.newProjectDraft = { name: "Fresh", instructions: "", pickedPath: null };
    // No timers advanced: it resolves on the write alone.
    await expect(createNewProject()).resolves.toBe(true);
    expect(app.view).toBe("chat");
    expect(app.projects[0].name).toBe("Fresh");
    expect(app.newProjectDraft.name).toBe("");
    await vi.advanceTimersByTimeAsync(REFRESH_LIMIT_MS + 50);
  });

  it("the New project tab and its draft ride two project switches, first in the strip (backlog 394)", async () => {
    app.tabs = tabs.emptyWorkspace();
    app.newProjectDraft = { name: "Half", instructions: "typed", pickedPath: null };
    showNewProject();
    const first = () => app.tabs.panes[0].tabs[0].content;
    await endsWithinLimit(useProject("a"));
    expect(first()).toEqual({ kind: "new-project" });
    expect(app.view).toBe("new-project");
    // A chat opened beside it (a plain click) lands after it.
    app.view = "chat";
    tabs.land(app.tabs, tabs.focusedPane(app.tabs), { kind: "chat", session: "x" }, "replace");
    await endsWithinLimit(useProject("b"));
    expect(first()).toEqual({ kind: "new-project" });
    expect(app.view).toBe("chat");
    expect(app.newProjectDraft).toEqual({ name: "Half", instructions: "typed", pickedPath: null });
    // Create closes it: the next switch's strip has none.
    app.newProjectDraft = { name: "Fresh", instructions: "", pickedPath: null };
    await expect(createNewProject()).resolves.toBe(true);
    expect(app.newProjectOpen).toBe(false);
    await endsWithinLimit(useProject("a"));
    expect(tabs.findAnywhere(app.tabs, { kind: "new-project" })).toBeUndefined();
  });

  it("opening a project ends at the limit when the lists hang", async () => {
    await endsWithinLimit(useProject("b"));
    expect(app.project?.id).toBe("b");
  });

  it("Open project… shows the picked folder's row and ends at the limit", async () => {
    await endsWithinLimit(openProjectFolder());
    expect(app.projects.map((p) => p.id)).toContain("picked");
    expect(app.project?.id).toBe("picked");
  });

  it("an import toasts without waiting for the list", async () => {
    await importFromClaude();
    expect(app.toasts.map((t) => t.text)).toContain("Imported 2 projects");
  });

  it("a rename renames the row in place without waiting for the list", async () => {
    await renameProject("b", "Better");
    expect(app.projects.map((p) => p.name)).toEqual(["a", "Better"]);
  });

  it("forgetting drops the row without waiting for the list", async () => {
    await forgetProject("a");
    expect(app.projects.map((p) => p.id)).toEqual(["b"]);
  });

  it("repointing the vault does not wait for its notes", async () => {
    await useKnowledgeDir("/elsewhere");
    expect(app.knowledge?.dir).toBe("/elsewhere");
  });
});
