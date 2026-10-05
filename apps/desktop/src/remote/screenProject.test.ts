import { describe, expect, it } from "vitest";
import { NO_PROJECT, callProject, notesProject, openedProject, placeProject, screenProject, type ScreenInput } from "./screenProject";

const base: ScreenInput = { chatId: null, chatPid: null, newProject: null, activePid: "garden", hasProjects: true };

describe("screenProject (300 B1)", () => {
  it("a chat on screen names its own project, not the host's open one", () => {
    expect(screenProject({ ...base, chatId: "c1", chatPid: "bird" })).toBe("bird");
  });
  it("a chat with no project is No project even while the host has one open", () => {
    expect(screenProject({ ...base, chatId: "c1", chatPid: null })).toBe(NO_PROJECT);
  });
  it("a new chat names the project it starts in", () => {
    expect(screenProject({ ...base, newProject: "bird" })).toBe("bird");
    expect(screenProject({ ...base })).toBe("garden");
    expect(screenProject({ ...base, activePid: "" })).toBe(NO_PROJECT);
  });
  it("an older host that lists no projects gets none", () => {
    expect(screenProject({ ...base, hasProjects: false, chatId: "c1", chatPid: "bird" })).toBeNull();
  });
});

describe("notesProject (300 B1)", () => {
  it("the re-test's repro: Bird log on screen while the host moved to Garden", () => {
    expect(notesProject({ ...base, newProject: "bird" }, true)).toBe("bird");
  });
  it("a host without ?project= on its notes routes gets its own open project, said so", () => {
    expect(notesProject({ ...base, newProject: "bird" }, false)).toBe("garden");
    expect(notesProject({ ...base, activePid: "" }, false)).toBe(NO_PROJECT);
  });
});

describe("an unfiled chat across a reload (300 review 1)", () => {
  it("a saved place names an unfiled chat as unfiled, never null", () => {
    expect(placeProject(null, true)).toBe(NO_PROJECT);
    expect(placeProject("bird", true)).toBe("bird");
    // A host that lists no projects: nothing to name.
    expect(placeProject(null, false)).toBe(null);
  });

  it("serve (lists unfiled): reopened as unfiled while Garden is open, and its calls say so", () => {
    const o = openedProject(NO_PROJECT, "garden", true);
    expect(o).toEqual({ pid: NO_PROJECT, other: NO_PROJECT });
    expect(callProject(o.pid, o.other, "garden", true)).toBe(NO_PROJECT);
  });

  it("the Mac (no unfiled row): never the open project, and never ?project=unfiled", () => {
    const o = openedProject(NO_PROJECT, "garden", false);
    expect(o.pid).toBe(null);
    expect(o.other).toBe(NO_PROJECT);
    expect(callProject(o.pid, o.other, "garden", false)).toBe(null);
    // Nothing open on the Mac: the unfiled chat is the open place.
    expect(openedProject(NO_PROJECT, "", false)).toEqual({ pid: null, other: null });
    // Notes from it name No project (the Mac's notes routes take `unfiled`).
    expect(screenProject({ chatId: "c1", chatPid: o.pid, newProject: null, activePid: "garden", hasProjects: true })).toBe(NO_PROJECT);
  });

  it("the old reading is gone: null from a place no longer becomes the open project", () => {
    // Before: openChat(id, null) set chatPid to the open project (Garden).
    const saved = placeProject(null, true);
    expect(openedProject(saved, "garden", false).pid).not.toBe("garden");
    expect(openedProject(saved, "garden", true).pid).not.toBe("garden");
  });

  it("a list's row and a named project behave as before", () => {
    expect(openedProject(null, "garden", true)).toEqual({ pid: "garden", other: null });
    expect(openedProject("bird", "garden", false)).toEqual({ pid: "bird", other: "bird" });
    expect(openedProject("garden", "garden", false)).toEqual({ pid: "garden", other: null });
    expect(callProject("bird", "bird", "garden", false)).toBe("bird");
    expect(callProject(null, null, "", false)).toBe(null);
  });
});
